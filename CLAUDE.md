# Web IDE — module instructions

Module ID `com.gaskony.scriptide` · Repo `Gaskony-Ignition/module-web-ide`

Read the workspace's `modules/CLAUDE.md` first for the suite-wide rules
(signing, dependency boundaries, Gradle/Java versions, skills). This file
covers only what is specific to this module.

## What it is

A browser-based Jython IDE for Ignition 8.3, served from the Gateway: Project
Library and Gateway event script editing, completions from the running
gateway, live error checking, an outline, a script console executing on the
Gateway, and project-wide navigation (go-to-definition, quick open, search
and replace, name-based references, a Problems panel).

**Public under Apache-2.0**, and on the modules portal. Release with
`./release.sh ignition-module-web-ide`; still built with its own
`./gradlew` and still outside `test-all.sh`.

## Entry points

| Need | Read |
| --- | --- |
| Mechanism behind the rules below | `docs/INTERNALS.md` |
| The Designer's export zip format | `docs/EXPORT-FORMAT.md` |
| The named-query resource contract | `docs/NAMED-QUERIES.md` |
| Writing Jython tests | `docs/TEST-FRAMEWORK.md` |

## Build, deploy, verify

```bash
./gradlew clean build        # includes the Vitest suite via `check`
cd scripts/testing
SI_GATEWAY_CONFIG=$PWD/config.local.json PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
  <venv>/python install_via_webui.py
SI_GATEWAY_CONFIG=$PWD/config.local.json PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
  <venv>/python deploy_gate.py   # the arbiter — must print PASS
```

Never claim a deploy worked, start live validation, or tag a release unless
`deploy_gate.py` prints PASS — the version string and JS hash are stamped at
build time and prove nothing about the code now running. Its socket check is
what proves the WebSocket servlet registered; the other checks pass green
even when it has not.

## Non-negotiables specific to this module

- **Jython is `compileOnly`, never `modlImplementation`** — same for Jetty,
  the servlet API and SLF4J. A second interpreter on the classpath gives the
  JVM two `PySystemState` registries, and `ScriptManager.interrupt()` then
  walks frames the running script is not in: the Stop button silently stops
  nothing.
- **Never execute user code through `ScriptManager.runCode()`** — it leaks
  output between concurrent users. Use a private `PySystemState` per run;
  see `docs/INTERNALS.md`.
- **Catch `Throwable`, not `Exception`, around user code** — a Stop is a
  Java `Error`.
- **The `"/*"` catch-all route mounts last** — first-match-wins with no
  most-specific preference, and mounted earlier it shadows every API route,
  with the API returning HTML as the only symptom.
- **No actor fallback in `SessionSecurity`** — this gate sits in front of
  arbitrary code execution.
- **Byte fidelity when writing scripts** — never convert a tab to spaces,
  never add or remove a trailing newline; the real Designer writes no
  terminating newline.
- **The UI font never comes from a theme pack** — a theme here is a palette,
  not a typeface. Never set `-webkit-font-smoothing` (macOS advice, wrong on
  Linux), and never let `ui-monospace` lead `--font-mono` (Chrome on Linux
  doesn't recognise it). See `docs/INTERNALS.md`.
- **`[hidden]` is forced globally in `index.css`** — several components stay
  mounted-but-hidden to keep state; removing `!important` shows them all.
- **The terminal's shell path is validated by an allowlist, never passed
  through** — it is interpolated into the string handed to `script -c`
  (`TerminalPolicy.isSafeShellPath`).
- **An inherited script is read-only until explicitly overridden**, matching
  the real Designer. `isLockedByInheritance` is the one place the rule lives.
  Overriding writes nothing until the first save.
- **A results list that is name-based must say so.** `scriptide/references`
  matches whole identifiers, not receivers — deliberately not
  `textDocument/references`.
- **A cross-file jump must hold a pending reveal**, because the target
  CodeMirror view does not exist until the next render.
- **`ETag` is a quoted entity tag; `If-Match` is parsed tolerantly** (`W/` and
  quotes stripped on the way in).
- **Every API call goes through `apiUrl`, never a bare `/api/...`** — the SPA
  is served from `/data/scriptide/` on a gateway, `/` under `npm run dev`.
- **A CSS class name is a shared claim — never reuse one for a new kind of
  thing.** Live suites select on class names.
- **Our own save is not somebody else's change.** `savingUris` covers the
  write's round trip; the tree is re-read and awaited on every save before a
  document leaves that set. A history restore loads the buffer; it never
  writes — the one write path stays the ordinary save. Drafts are
  `localStorage`, per viewer and invisible to the gateway; every read and
  write is wrapped, since it throws in a private window.
- **A template is compiled by the gateway before shipping**, checked against
  live `system.*`. A style lint goes over the AST, never the text — the bar
  is zero false positives. Organise imports treats a docstring as prose, not
  code, and refuses rather than guessing on a syntax error or star import.
- **Completion never waits on a database or a tag browse** — both are cached
  with a TTL, and a miss answers nothing for that keystroke while a
  background refresh fills the cache.
- **Test discovery is narrow on purpose** — a test lives in a module whose
  last name starts with `test`, or under a `tests` package, never `def
  test_*` anywhere, which would put a PLC-diagnostic function under Run All.
- **Presence is a warning, never a lock.** `If-Match` on the write path
  prevents a lost update; presence only lets two people find out about each
  other before the conflict. A session-level sweep must never blank resources
  the event feed found — the two feeds race by construction.
- **This module is not becoming a git module** — git status in the tree is
  read-only; staging, committing and remotes belong to `module-git`.
- **The two terminal elevation routes (Docker socket, sudo) are not the same
  risk and must keep separate switches**; see `docs/INTERNALS.md`. Never
  identify the container by hostname — `network_mode: host` means
  `ContainerIdentity` must read `/proc/self/mountinfo` instead. Closing a
  terminal does not kill the shell by itself; the reap sweep is load-bearing.
- **Policy is read live, file first**: `<gateway data dir>/modules/scriptide/policy.properties`
  resolves as file > `-D` property > default, re-statted every 2s. The
  module never creates the file — absent means no overrides.
- **A live suite creates the fixtures it destroys**, and clears its own first.
