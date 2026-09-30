# Security

## The threat model, stated plainly

**An Administrator using this module can do anything the Gateway JVM can do.**

That is not a new capability. Designer access already runs arbitrary Jython on the
gateway, and anyone with the Administrator role already has it. This module makes
that power reachable from a browser; it does not create it.

**There is no sandbox, and there will not be one.** A convincing-looking sandbox is
worse than none, because people trust it. The sibling `python3` module shipped an
AST-based "restricted mode" and deleted it in May 2026 after
`[].__class__.__mro__[1].__subclasses__()` walked straight through — the lesson is
recorded here so nobody rebuilds it.

## What is enforced

| Action | Requirement |
| --- | --- |
| Load the SPA shell | none (so the Gateway login can be presented) |
| Session probe `/api/auth/session` | none — answers `authenticated:false` rather than 401 |
| Read scripts, language features | authenticated Gateway session |
| **Write** a script or its attributes | session + **Administrator** + `X-CSRF-Token` + `If-Match` signature |
| **Execute** a script | session + **Administrator** + CSRF token on the socket + same-origin handshake |
| **Open a Gateway terminal** | session + **Administrator** + CSRF token on the socket + same-origin handshake, and its OWN kill switch |

Specifics that matter:

- **Identity is baked in at the WebSocket handshake** and is `final`. Nothing the
  client sends afterwards can change who a socket is.
- **Policy is re-read per frame**, not cached at connect, so disabling execution
  takes effect on sockets that are already open.
- **No actor-string fallback.** A sibling module grants access to a non-session
  caller presenting a non-empty `RequestContext.getActor()`, and its own Javadoc
  flags that as unvalidated. This module drops it entirely: what sits behind the
  gate is arbitrary code execution, and nothing but a browser talks to this module.
- **Type gating.** The resource routes are generic over `<moduleId>/<typeId>`, so
  both read and write demand `moduleId == "ignition"` *and* a known script type. A
  Perspective view or a tag configuration cannot be written through them.
- **Every execution is audited** before it runs, recording a SHA-256 of the source
  plus its size — never the source itself. Streaming the output back (1.5.0)
  changed nothing here: the chunks go to the one socket that submitted the run and
  are never retained by the module. An audit table is not a code store, and
  a credential typed into the console must not be copied into one.

## The terminal (1.3.0)

The Terminal tab attaches a **real shell on a pseudo-terminal** to the browser,
running as the Gateway JVM's own operating-system user.

**It grants no privilege that was not already reachable.** An Administrator with
the Script Console can call `java.lang.Runtime.exec` from Jython today and get the
same shell as the same user. What the terminal changes is convenience, which is
the point of a tool — and convenience is worth stating out loud rather than
hiding behind the equivalence argument.

It is gated exactly as execution is, through **its own** properties, so a site can
keep the Script Console and refuse the shell:

| Property | Default | Effect |
| --- | --- | --- |
| `com.gaskony.scriptide.terminal.enabled` | `true` | `false` refuses every terminal, gateway-wide |
| `com.gaskony.scriptide.terminal.shell` | first of `/bin/bash`, `/usr/bin/bash`, `/bin/sh` | absolute path to the shell |
| `com.gaskony.scriptide.terminal.maxPerSession` | `3` | shells one browser tab may hold open, capped at 8 |
| `com.gaskony.scriptide.terminal.idleMinutes` | `120` | a silent shell is closed after this |
| `com.gaskony.scriptide.terminal.privileged` | `true` | try for a root shell — see Elevation below |
| `com.gaskony.scriptide.terminal.docker` | `true` | `false` refuses the Docker route, keeping sudo |

`terminal.requireAdmin=false` needs `terminal.acknowledgeRisk=true` alongside it,
the same two-flag shape as execution, and warns on every open. Every property
here can be set as a `-D` at boot or in the live policy file — see "Turning it
off".

Three specifics:

- **`terminal.shell` is validated, not passed through.** The value is interpolated
  into the string handed to `script -c`, so it must be an absolute path, to an
  existing executable, matching `[A-Za-z0-9/._+-]+` — an allowlist, so the rule
  cannot be defeated by a metacharacter nobody thought of. A rejected value logs a
  warning and falls back to a built-in candidate.
- **Terminal ids are scoped to the connection that opened them.** An id from
  another browser tab addresses nothing, so a leaked or guessed id is not a live
  shell somebody else can type into.
- **Individual commands are NOT audited, and cannot be.** The audit line is
  written when a terminal opens, naming the user, the remote host and the shell. A
  pty carries keystrokes, not commands: reconstructing what was run would mean
  keeping a transcript of everything typed, including anything pasted. Auditing
  the open is honest; auditing the session would be a credential store.

### Elevation (1.4.0)

`com.gaskony.scriptide.terminal.privileged` defaults to **`true`**, and when it is
on a new terminal takes the Docker route if the host allows it and otherwise runs
`sudo -n -H <shell> -i` instead of the shell directly.

**This cannot make a gateway more privileged than its host already made it.** The
module is Java inside a JVM that is already running as the Gateway's own
operating-system user, and no property makes a process more privileged than the
process that started it. Elevation happens only where `sudo -n true` **already
succeeds** for that user — proved by running it, not by reading `/etc/sudoers` —
and on every stock Ignition image it does not, so the probe fails in milliseconds
and the user gets the ordinary shell.

Where it *does* succeed, the equivalence that justifies the terminal still holds:
on such a host an Administrator can already reach a root shell from the Script
Console with `Runtime.exec`. What changes is convenience.

Three specifics:

- **`-n` is load-bearing.** Without it, `sudo` on a host that would prompt sits
  waiting for a password no browser terminal can supply, and the shell looks hung
  rather than unprivileged. A unit test asserts the probe returns promptly.
- **Elevation goes inside the pty, not around it.** `script` itself stays the
  Gateway user, so the process this JVM has to signal is one it owns. Running
  `sudo script` would give us a root process the JVM cannot kill, and the idle
  sweeper would be a promise the module could not keep. On an elevated terminal
  the descendant `destroy()` is refused by the OS and the shell exits on the
  pty's SIGHUP instead — that is the mechanism, not a fallback. Since 1.5.0
  `script` is killed outright when it has not gone 300 ms after SIGTERM, because
  it handles SIGTERM and an interactive bash ignores it.
- **The audit line records `elevation=`**, one of `docker-exec`, `sudo` or
  `none`. "Opened a shell" and "opened a root shell" are different events to
  whoever reads the log later, and the answer is decided by the host rather than
  by anything the user sent. The line is written before the shell starts, so it
  records what was EXPECTED; since 1.5.0 the session reports what it actually
  got, and a mismatch — the Docker route failing and the shell falling back to a
  local one — is logged as a WARN naming both. A log that quietly overstates
  privilege is worse than no log.

### Two routes, and they are NOT the same risk (1.4.2)

Elevation is tried in this order, and both are proved by *doing* them rather than
by reading configuration:

| Route | What the host must already allow | What it grants |
| --- | --- | --- |
| **Docker daemon** (preferred) | its socket mounted and writable by the Gateway's user | a root shell in this container — and, to anything that can reach the socket, **root on the HOST** |
| **sudo** | a passwordless sudoers rule for the Gateway's user | root **in this container** |
| neither | — | the ordinary shell |

They arrive at the same place, so it is easy to treat them as interchangeable.
They are not, and the difference is about the *host*, not the terminal:

- The **sudoers rule** is bounded by the container. It is also permanent and
  broad within it — every process running as that user can become root,
  including Jython from the Script Console.
- The **Docker socket** is the daemon's full API, running as **root on the
  host**. Anything that can reach it can start a privileged container that
  mounts `/` and own the machine, whatever this module chooses to do with it.
  `DockerExec` deliberately implements nothing but exec-into-one-container, but
  that is a self-imposed limit, not a security boundary.

So the socket is the **larger** grant, not the smaller one, even though it is
the tidier mechanism. Mount it only where you would already accept host-root
exposure. `terminal.docker=false` refuses that route from the gateway side while
keeping sudo; `terminal.privileged=false` refuses both.

What the Docker route is genuinely better at, once you have accepted it: nothing
has to be installed in the image, the pty comes from the daemon rather than being
borrowed from `script(1)`, and resize is an API call rather than an `stty` typed
at the shell.

**Closing is not one of them.** Until 1.5.0 this section claimed the shell exits
when the hijacked connection closes, because it is the daemon's child. Measured
false on 02/09/2026: the Engine API has no "kill this exec", the daemon keeps the
process running detached, and thirty-eight orphaned root `bash -i` processes were
found in the test container — one for every terminal ever opened — with the
120-minute idle reaper calling the same no-op. See "Ending a terminal" below.

### Ending a terminal (1.5.0)

Every shell is closed when its socket closes, when the idle sweeper fires, and
when the module shuts down. Neither route ends by itself, and each needs its own
sequence:

- **The Docker route.** ETX (^C), then EOT (^D), then a literal `exit` for a
  shell with `ignoreeof` set; the exec is then polled for `Running:false` for up
  to 750 ms. That cannot reach a background job — `sleep 300 &` outlives its
  shell by design — so a second, non-tty root exec ALWAYS runs afterwards and
  walks `/proc/*/environ` for `SCRIPTIDE_TERM=<terminal id>`, sending `SIGHUP`,
  waiting a second, then `SIGKILL`. The tag is the terminal id this module
  minted, it is inherited by everything the shell starts, and it is matched
  whole-line, so the sweep takes a shell's own jobs with it and nothing else. A
  shell still running after both steps is logged as a WARN. The exec's own `Pid`
  is not usable for any of this: the daemon reports it in the HOST pid namespace,
  where this JVM can neither see nor signal it.
- **The `script(1)` routes.** Descendants and `script` get `destroy()`, then
  `destroyForcibly()` 300 ms later. `script` installs a SIGTERM handler and an
  interactive bash ignores SIGTERM outright, so SIGTERM alone left every process
  running; SIGKILL on `script` closes the pty master, the slave raises SIGHUP and
  bash hangs up its own jobs on the way out. On an elevated terminal the
  descendants are root and this JVM is not, so those signals are refused
  silently — which is exactly why `script` itself is killed rather than only its
  children.

Module shutdown waits (bounded at 10 s) for the Docker sweeps it started, because
they run on a daemon thread that the JVM would otherwise simply drop — leaving
behind the root shells shutdown was closing.

## Turning it off

Two places, and the file wins: a **live policy file** first, then a JVM system
property set in `data/ignition.conf` as
`wrapper.java.additional.N=-D<key>=<value>`, then the built-in default. Both
`ExecPolicy` and `TerminalPolicy` read through the same source, so one file covers
execution and the terminal alike:

| Property | Default | Effect |
| --- | --- | --- |
| `com.gaskony.scriptide.execution.enabled` | `true` | `false` refuses every execution, gateway-wide |
| `com.gaskony.scriptide.execution.timeoutSeconds` | `60` | per-execution budget, capped at 600 |
| `com.gaskony.scriptide.execution.maxConcurrent` | `4` | size of the module's own thread pool |
| `com.gaskony.scriptide.audit.includeSource` | `false` | `true` also writes full source to the module log |

`execution.requireAdmin=false` exists but is **ignored unless
`execution.acknowledgeRisk=true` is also set**, and then warns on every execution.
Two flags, because handing arbitrary Gateway-JVM execution to every authenticated
user should not be reachable by one typo'd property.

An unparseable boolean falls back to the **secure** value, never to `false`.

### The live policy file (1.5.0)

```
<gateway data dir>/modules/scriptide/policy.properties

# Standard java.util.Properties syntax. Keys are the SAME fully-qualified names
# used as system properties, so a line can be copied straight out of
# ignition.conf with the -D removed. Unknown keys are ignored.
com.gaskony.scriptide.execution.enabled=true
com.gaskony.scriptide.terminal.enabled=true
com.gaskony.scriptide.terminal.privileged=true
com.gaskony.scriptide.terminal.docker=true
```

Both policy classes already re-read their values on every call — and every value
came from a system property, which is read once, when the JVM starts. So "turn
the terminal off without restarting anything" was true of the code and false of
the gateway: it meant editing `ignition.conf` and bouncing the gateway, which the
estate's no-restart rule forbids. The file closes that gap; the system property
stays, because it is the right way to state a fleet default at boot.

- **The module never creates this file.** Absent means "no overrides", which is
  where every existing gateway already is.
- **Its permissions are a security control in their own right**, exactly as
  `ignition.conf`'s are: it can turn the Administrator requirement off, so it must
  be readable and writable by the Gateway's own operating-system user and by
  nobody else.
- **It is re-statted at most once every 2 seconds**, on mtime and size together —
  not watched — so a change lands within two seconds without a thread, a
  lifecycle or a shutdown hook.

## Isolation

Each execution runs on the module's own bounded thread pool — never the gateway's
executor, because one `while True:` on that would take the gateway down rather than
just this module.

Each execution gets a **private `PySystemState`**, so concurrent users cannot see
each other's output. This is measured, not assumed: the obvious approach
(`ScriptManager.addStdOutStream` with per-thread routing) leaked 22–25 lines
between concurrent users, because Jython's `sys.stdout` is a single shared buffer.
The replacement measures 0 cross-talk over 500 lines each way, and that test runs
against the live gateway on every release.

## Stopping a script is best-effort

**Until 1.5.0 the Stop button could not work at all**, whatever the interpreter
did: the socket's frame handler blocked inside the execution, and
`ScriptIdeSocket` reads one frame at a time on the socket thread — so a stop sent
into a running loop was not READ until the loop had ended, and the LSP and the
terminal queued behind it too. Execution is submitted and returns now, and
`started`, `output` and `finished` are sent from its callbacks.

What the interpreter does is unchanged, and is still best-effort.
`ScriptManager.interrupt()` fires at the next Python trace point. Measured: a 15 s
busy loop stops in 3.0 s; an interrupted `time.sleep(10)` still runs the full
10.06 s. A script blocked in a JDBC call, a socket read, or `time.sleep` **cannot
be stopped**, and the UI says so rather than showing a button that lies. After
escalation the execution is marked abandoned and counted — a Java thread cannot be
killed.

## Reporting

Internal module. Raise anything you find with Nigel directly.
