# Internals reference

Detail behind the rules in `CLAUDE.md`. Read a rule there first; come here for
the mechanism.

## Execution isolation

Never execute user code through `ScriptManager.runCode()` — it leaks stdout
between concurrent users, because Jython's `sys.stdout` is a single shared
buffer. Use a private `PySystemState` per execution, with the manager's module
map copied and the copy's `sys` repointed at our own state. Both refinements
are load-bearing; removing either breaks isolation.

Catch `Throwable`, not `Exception`, around user code — a Stop raises a Java
`Error`, which escapes Jython's exception machinery entirely.

**An imported project-library module object is the gateway's, not the run's.**
`__import__` of a library module returns the manager's own object: the same
`id()` across separate runs, a module global set in one run read back by the
next, and `system` living in each module's own globals rather than in
builtins. Never write into one. The test runner executes each selected test
module's source into a namespace private to the run; when the source cannot be
read it falls back to importing and a mock then refuses rather than writing
into the shared copy. A mock reaches the test module's own namespace only —
production code the test calls has its own module globals and still reaches
the real gateway.

**Loading a library module moves the thread onto the platform's system state.**
Ignition loads a project-library module lazily, on first attribute access, by
running it through `ScriptManager.runCode` — which calls
`Py.setSystemState(manager.sys)` on the calling thread and never restores it.
The load can happen anywhere, including inside project code the console
called, so it cannot be intercepted; it happens only on a module's first use
after the library is (re)built.

- **Output: `RunOutputRouter`.** Each project manager's `sys.stdout` and
  `sys.stderr` are replaced, once, by an unbuffered `file` over a per-thread
  switch: a thread inside a Web IDE run writes to that run's capture, every
  other thread to the manager's original file. It stays a real `PyFile`
  because Jython's `print` fast path, including its flush after every print,
  only applies to one; it stays unbuffered so bytes are routed on the thread
  that produced them. The originals go back on module shutdown.
- **`sys`: `PrivateStateRunner.installImportHook`.** An import that loads a
  module itself (`from M import f`, `import P.sub`) is followed by a restore
  of the run's own state. A load at `M.f` is not, so after it the thread's
  system state is the platform's until the run ends.

There is no namespace-local builtins table in Jython — never write to
`__builtins__` in place. Every `PySystemState` shares
`PySystemState.getDefaultBuiltins()`, so a direct edit replaces a builtin for
the whole JVM. Copy the table, mutate the copy, set it on the state and in the
run's globals, and copy from the state's builtins, never from the namespace's
— the console's namespace outlives a run.

A test harness must never catch bare `except:` — a Stop and the execution
timeout arrive as a Java `Error`, not an `Exception`, and a bare handler
swallows it and carries on to the next test.

A test run's output needs three separate things, each of which fails
silently: run every import before any output (importing after printing loses
the whole run's output); re-assert the private system state after the imports
(an import leaves the thread on the platform's state); and flush from inside
the harness (Jython buffers `sys.stdout`, and the runner's tail-flush does not
reach that buffer on a batch run). A batch run passes no output listener —
streaming needs a socket, and a listener from an HTTP request thread is never
called.

## Byte fidelity and the export format

Scripts are written byte-identical to the Designer: no tab-to-space
conversion, no trailing newline added or removed.

The export zip's entry paths come from `HandlerSupport.encodePath`, never
`ResourcePath.getPath()` — the latter drops the module and type. In the
Designer's own format the paths are the index; there is no manifest. See
`docs/EXPORT-FORMAT.md` for the measured shape of that format.

An uploaded archive is checked decompressed, and traversal is refused rather
than sanitised — a `..`, an absolute path or a backslash names an error rather
than being stripped, because these become `ResourcePath`s, not filenames.
`ZipInputStream` does not throw on non-zip data; check the `PK` magic.

A PEP 263 coding declaration breaks the parse: everything here parses from a
`StringReader` (Unicode text), and Python 2 refuses a coding declaration in
one. `ModuleSymbols.neutraliseCodingDeclaration` changes only the word
`coding` to one of the same length, because every reported position is a
range in the editor. The same neutralisation is applied in the test-run path
(which compiles via `Py.java2py`, a Unicode string) and deliberately left
alone in the script console path (which compiles a Java String — a byte str —
and never had the problem).

## Terminal

The terminal tries for root and cannot force it — a process cannot raise its
own privilege. Two routes, both decided by the host: the Docker daemon (asks
for an exec with `User:"0"`), or `sudo -n` where the host grants it (`-n` is
load-bearing — without it a prompting host hangs the shell). These are not
the same risk: sudo grants root inside this container; the Docker socket is
the daemon's full API as root on the host, which is the larger grant despite
being the tidier mechanism. Keep them on separate switches.

Resize a Docker exec after the attach, never before — the daemon has no exec
session to size until the attach happens. `Tty: true` on a Docker exec both
gives the shell a real pty and makes the attached stream raw; `Tty: false`
multiplexes stdout/stderr behind a frame header that reaches xterm.js as
garbage.

Closing the hijacked attach does not kill the shell — the Engine API has no
"kill this exec", so the daemon keeps the process running, detached, under a
host pid this JVM cannot see or signal. A close sends ETX/EOT/`exit`, polls
briefly, then always runs a root sweep exec that walks `/proc/*/environ` for
the terminal's own tag and kills what it finds.

## Git status

`GitProbe` reads the working tree with JGit at
`<dataDir>/projects/<Project>/.git` — the same path `module-git`'s
`GitManager.getProjectFolderPath` resolves. An unresolvable HEAD makes JGit
report every tracked file as untracked; check `getFullBranch()` before asking
for status.

## Presence

The Designer feed reaches an internal platform type
(`DesignerResourceSessionEvent`, in `gateway.jar`, not the SDK) by class name,
and could stop matching after a patch release with nothing failing anywhere.
`PresenceSweep` from `GatewaySessionManager` is the supported floor under it.
A presence subscriber sees the whole gateway's event bus (Guava dispatches by
parameter type, so the listener subscribes to `Object`) and must never throw.
The registry is keyed on the resource path, never the session id, which stays
server-side.

## UI conventions

The UI font never comes from a theme pack — a pack names a typeface as part
of a brand, and applying one can set the whole IDE in a serif the palette
never intended. A theme here is a palette, not a typeface.

`[hidden]` is forced globally in `index.css`. Several components stay
mounted-but-hidden to keep state (the editor under a maximised panel, an
inactive panel tab, a non-active CodeMirror view), and the user agent's
`[hidden]` rule loses to any `display:` rule in our own stylesheet without the
`!important`.

Never set `-webkit-font-smoothing` — it is macOS advice; on Linux it forces
greyscale over the platform's subpixel default. `ui-monospace` must never
lead `--font-mono` — Chrome on Linux does not recognise it and can resolve it
to a proportional face.
