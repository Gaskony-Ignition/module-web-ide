# Changelog

All notable changes to this module (Script IDE until 1.28.0). Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.29.1] — 2026-09-30

- The Query Browser's table tree has a refresh button, and reloads itself after a run that returns an update count (`CREATE`, `ALTER`, `DROP`, …), so a table made in the browser shows straight away instead of after the gateway's five-minute schema cache.

## [1.29.0] — 2026-09-29

Query Browser additions:

- The tree is schema-qualified: each table carries its own schema and JDBC type, and a table outside the datasource's default schema shows and inserts as `schema.table`, quoted only where the identifier actually needs it (a reserved character, a leading digit, a case the database would fold, or a name that is a reserved keyword in that dialect). Grouped under a schema heading when a datasource has several; a flat list otherwise, as before. Two same-named tables in different schemas each get their own row and columns.
- The SQL editor completes table and column names from the loaded schema, in the connection's own dialect (PostgreSQL, MySQL/MariaDB or SQL Server), via `@codemirror/lang-sql`'s schema completion, which quotes an inserted name itself. Columns for a table you type or qualify by hand load lazily, the same way expanding it in the tree does. Completion never blocks typing.
- **Save as Named Query**: a toolbar button opens a dialog for the target path, query type and datasource (preselected), and creates the query — sql and settings together, in one write — through the existing named-query write path, refusing a path that already exists as a query or a folder, or that would overlap one (a query cannot also be a folder, in either direction). In the main workspace it refreshes the Named Queries tree and offers to open the new query; in a pop-out it just confirms.
- Results: click a column header to sort (ascending, then descending, then off) — numeric or text is decided per column from its declared type, never guessed per cell, and a numeric column compares a value sent as a string (for bigint/decimal precision) exactly, without rounding through a float; nulls sort last. A per-result filter box narrows rows by substring and reports "n of m rows"; columns are drag-resizable; a roving tabindex moves between cells with the arrow keys, and Enter (or a click) opens a focus-trapped cell viewer showing the full value, pretty-printed if it is JSON, with a note when the server's 16 KB per-cell limit truncated it.
- Auto-refresh: Off/5/10/30/60 s, reruns the last executed SQL on its datasource (never the current buffer), sending a best-effort read-only hint to the driver, and only while that last run returned at least one result, none of it truncated, and every result was a result set — an update/DDL result, an empty or truncated run, or a failure turns it off with a visible reason (a "too many queries running" reply is treated as transient and left running). Never overlaps a running query, pauses while the tab is hidden, and stops on a datasource change, a manual run of different SQL, or Stop. A refresh run sends `recordHistory:false`; it is still audited, just not added to the per-user history list.
- Export CSV downloads the current (sorted, filtered) result as RFC 4180 — comma/quote/newline fields quoted, embedded quotes doubled, CRLF lines, a UTF-8 BOM — named `<datasource>-<yyyyMMdd-HHmm>.csv`, and says when the export only holds a capped result's returned rows. Copy as TSV follows the same sort and filter. Both prefix a cell that opens with `=`, `+`, `-`, `@`, a tab or a carriage return with `'`, unless the whole value is a plain number, so a spreadsheet never reads a cell as a formula.
- A "Clear SQL" button empties the editor as an ordinary edit — Ctrl+Z undoes it — and forgets the autosaved buffer; every keystroke still saves immediately, so a reload right after typing keeps it.
- Ctrl+Shift+Enter (and a toolbar button) runs only the statement containing the cursor, split per the connection's own dialect: `;` everywhere, plus PostgreSQL's `E'...'` backslash escapes, `$tag$...$tag$` strings and nesting `/* */` comments, MySQL/MariaDB's `\`-escaped strings and `#` line comments, and SQL Server's `GO` batch separator. A cursor right after the `;` it just typed (before the next line) still runs the statement just finished; a cursor on a blank line between statements runs nothing; a buffer ending inside an unterminated string or comment refuses rather than guess. Ctrl+Enter is unchanged.

Script Console:

- Its own project picker, independent of the workspace's — like the Query Browser's own datasource. Starts on the workspace's current project (or a pop-out's `?project=`), remembers the last choice, and from then on every Run, Reset, Export and traceback link acts on whatever the picker is set to; switching the workspace's own project no longer remounts the console or drops its buffer. Each run's own header now names the project it ran in, since a scrollback can span more than one.
- The script survives a reload, a sign-out, a closed pop-out or a project switch — one shared draft per browser, saved on every keystroke, not per project. A "Clear script" button resets it to the starter text (Ctrl+Z undoes it) and forgets the saved draft.

Script Console changes:

- The console has its own Project picker in its toolbar, independent of the IDE's own project switcher — the same shape as the Query Browser's datasource picker. Run, Reset, Export and a traceback link all act on whichever project is selected there. Starts on the workspace's current project (or `?project=` in a pop-out) and remembers the last choice; a remembered project no longer on the gateway falls back to that starting project instead. Switching the IDE's own project no longer remounts the console or clears its picker.
- The console's autosave buffer is one shared draft, not one per project — matching the Query Browser's own SQL buffer, which was never per-project either. "Clear script" resets it to the starter text and forgets the saved draft; Ctrl+Z undoes the clear, since it is an ordinary CodeMirror edit.

## [1.28.1] — 2026-09-29

- A popped-out console or Query Browser says which it is: the browser tab reads "Script Console · <project> — Web IDE" or "Database Query Browser · <datasource> — Web IDE", and the header shows the same next to the version. The main IDE tab carries the project name.

## [1.28.0] — 2026-09-29

The module is renamed **Web IDE** (was Script IDE):

- Its name in Config › Modules, the release file (`WebIDE-<version>.modl`, was `ScriptIDE-…`), the repo (`Gaskony-Ignition/module-web-ide`), the portal entry, and the docs.
- The module ID stays `com.gaskony.scriptide`, so an installed Script IDE upgrades in place and keeps its history, settings and policy file. The audit trail's originating system and action (`ScriptIDE`, `script-ide-execute`) are unchanged too, so existing audit queries keep matching.

## [1.27.5] — 2026-09-29

Query Browser fixes found testing MySQL 9.7 through Ignition's bundled MariaDB driver:

- The run's time limit is enforced by the module, not only by the driver's `setQueryTimeout`: a watchdog cancels the statement at the deadline. The MariaDB driver against a MySQL server ignored the timeout, and a 65 s query under a 60 s limit ran to the end. A timeout is now reported as `TimedOut`, not as a driver error.
- A run that was stopped is reported as Stopped even when the driver returns normally (MySQL's `SLEEP()` does when killed); it came back as a success before.
- A timestamp with no zone in its type (PostgreSQL `timestamp`, MySQL `DATETIME`/`TIMESTAMP`, SQL Server `DATETIME2`) renders as wall-clock time with no `Z`, whichever driver returns it. Zoned types (`timestamptz`, `DATETIMEOFFSET`) are unchanged.

## [1.27.4] — 2026-09-29

- Loading the schema tree no longer leaves a 30-second network timeout on the pooled connection it borrowed. Left there, the next query over 30 s on that connection — the historian's, a named query's, the Query Browser's — failed with a link failure. Introduced in 1.27.0; no earlier release has it.

## [1.27.3] — 2026-09-29

Query Browser fixes found testing against SQL Server 2025 with mssql-jdbc:

- A `USE otherdb` no longer sticks to the pooled connection: the connection is put back in the database it was borrowed in after every run. Before this, 8 of 8 later borrows on SQL Server landed in `master`, where the historian or a named query would have run next. `SET` options and temp tables still persist.
- SQL Server's `sys` and `INFORMATION_SCHEMA` views are left out of the schema tree (they were 499 of its 500 entries).
- A `DATETIMEOFFSET` renders as ISO-8601 (`2026-09-29T13:45:30.250+10:00`) instead of the driver's own format.

## [1.27.2] — 2026-09-29

Query Browser fixes found testing against MySQL 9.7 with Connector/J:

- A `TIME` column keeps its fractions of a second (`13:45:30.500` rendered as `13:45:30`).
- The schema tree lists only the connected database's tables and columns, not every database the user can see.

## [1.27.1] — 2026-09-29

- The gateway nav link, launch page, browser tab title and in-app wording now say "Web IDE". The module's name in Config › Modules, its ID and the repo are unchanged.

## [1.27.0] — 2026-09-28

feat: Database Query Browser — ad hoc SQL against any configured datasource.

- A new bottom-panel tab beside the Script Console: a schema tree (tables, views, lazily-loaded columns with their types, a filter box), a SQL editor, and a results area, with the same pop-out-to-a-new-tab action as the console.
- Runs plain JDBC directly — `Statement.execute` plus `getMoreResults()`/`getUpdateCount()` — so a `SELECT`, an `UPDATE`, a DDL statement or a `;`-separated batch all come back correctly with no keyword sniffing. Multiple results render as one section each.
- Stop cancels a running statement (`Statement.cancel()`) by a run id the browser generates itself, since the request is synchronous and a server-minted id would arrive too late to click.
- Gated exactly like a console run: Administrator, CSRF-checked, `ExecPolicy.executionEnabled()` re-checked live, and audited (hash, not source) before execution.
- Row cap is server-side (default 1000, hard ceiling 10000) via `Statement.setMaxRows`, so a large result is capped without ever being fully materialised; the client is told when it was truncated.
- Per-user query history, kept across restarts like console runs but in its own store — a query keeps its datasource and a row/affected summary rather than captured output.
- Results copy as TSV; a SQL error renders through the same traceback component a failed console run or named-query test uses.
- Bounded four ways, independent of the row cap: a cell's text past 16 KB is truncated with a visible marker (a CLOB is read via a bounded `getSubString`, never in full; a BLOB is only ever sized, never read; an SQL `ARRAY` is previewed, not materialised); a whole run's cell text stops at a 32 MB budget; no run returns more than 50 separate results — any of the three stops the run early and says `resultsTruncated` in the response rather than silently handing back less than it looks like.
- A `Long`/`BigInteger` outside JavaScript's safe-integer range, and a `BigDecimal` a `double` cannot hold exactly, are sent as strings rather than JSON numbers — otherwise the wire bytes are exact but the browser's own `JSON.parse` silently rounds them. A non-finite `double`/`float` (`NaN`, `Infinity`) is sent as a string too, since JSON itself has no token for either. Numeric columns still read right-aligned in the grid either way.
- Concurrent runs on this gateway are capped at `ExecPolicy.maxConcurrent()` (a 409 past the limit); a run also has an overall wall-clock deadline, not only a per-statement one, so a batch of many quick statements cannot add up to an unbounded total.
- A statement that leaves a transaction open is rolled back before the connection returns to Ignition's shared pool, and the response says so (`rolledBackTransaction`). Session settings a statement changes (`SET`, a temp table) are NOT rolled back — they persist on the pooled connection for whoever borrows it next, the same as running the same SQL by any other means against that pool.
- Multiple `;`-separated statements in one run work only as far as the JDBC driver allows: PostgreSQL's simple query protocol accepts a batch, MySQL needs `allowMultiQueries` on the datasource's connection URL, and Oracle rejects a trailing `;` outright. This module does not special-case any driver — whatever it accepts is forwarded, whatever it refuses comes back as an ordinary SQL error.
- Dates: `java.sql.Date` renders as a plain `yyyy-MM-dd` (no invented time-of-day, no UTC shift near midnight); `java.sql.Time` as `HH:mm:ss[.fff]`; `java.sql.Timestamp` keeps its sub-millisecond precision rather than being rounded to whole milliseconds.

## [1.26.1] — 2026-09-25

fix: WCAG 2.1 AA across the IDE chrome.

- The code editor and Script Console now name themselves to assistive tech, and Escape reliably drops focus out of them so Tab is never trapped — the README says which key.
- A real focus ring on the pane-resize divider and on five inputs that were missing one.
- The tab strip no longer claims to be an ARIA tablist it never behaved like; it is a labelled group instead, with the open tab marked by `aria-current`.
- Quick Open's result columns read at 3:1 on the highlighted row; raised to pass. Its list now has a name of its own.
- The import file picker and the file tree's git-status badge are readable by assistive tech; the outline panel's smallest text was under 11px.

## [1.26.0] — 2026-09-23

fix: console output no longer lost after the first use of a library module; runs fold.

- Fixed: on the first run after a project library was (re)built, everything printed after the first use of a library module went to the gateway log instead of the console. Ignition loads the module on first attribute access and leaves the thread on the platform's system state; each project's platform `sys.stdout`/`sys.stderr` is now wrapped once with a per-thread switch that sends a Script IDE run's writes to its own output and every other thread's to the original stream, unchanged. The originals are restored on module shutdown.
- Each console run is now a block whose `run N · time` header folds and unfolds its output — a button with `aria-expanded`, operable from the keyboard, expanded by default. Export still writes every run in full.

## [1.25.0] — 2026-09-07

feat: git status in the tree — which resources differ from the last commit.

- Read-only: shows changes since the last commit, never stages, commits or touches remotes.
- Reads `.git` with JGit in pure Java, since the rig has no `git` binary.
- A deleted resource's mark rolls up to the nearest surviving tree node; folders carry the worst mark below them.
- An unresolvable HEAD is reported rather than rendering every tracked file as untracked.
- Polls only for projects an IDE client has open, at a 10s interval.

## [1.24.0] — 2026-09-07

feat: templates, autosave and crash recovery, console export and timestamps.

- Autosave keeps every unsaved buffer in the browser and offers it back after a reload; restore loads over the gateway's current copy and never writes on its own.
- Six "New from…" templates for a new library script, each compiled against the live gateway's Jython before shipping.
- Console Export saves the output as a timestamped, ANSI-stripped text file.
- Console Times toggle, remembered per viewer, rendered outside the `<pre>` so copying the output never includes it.
- Fixed: a stale `web-<version>.jar` left in `build/moduleContent` failed `zipModule` with a multi-version library error; a clean build clears it.

## [1.23.0] — 2026-09-07

feat: presence — who else has this file open, and where they are working from.

- Other open IDE tabs are reported over the socket; a registry pushes changes to every client.
- Designer sessions are read from the platform's internal event bus (not SDK-stable; falls back to session-level presence if it stops matching).
- A warning, never a lock — `If-Match` is what prevents a lost update.
- Shown as a bar above the editor, a badge on the tab, and `GET /api/presence`.
- Run history is now searchable over source and output, and records duration.
- Fixed: two redundant null checks SpotBugs flagged on non-null SDK return values.

## [1.22.0] — 2026-09-07

feat: snippets, organise imports, live tag and schema completion, style lints, and colour in the console.

- Eighteen snippets with tab-stops in the completion popup.
- Organise imports: sorts, de-duplicates, removes unused; loaded as an ordinary undoable edit.
- Suggested imports for an undefined name, from the project's own modules first.
- Live tag-path completion inside a string literal, and table/column completion inside SQL-like strings.
- Seven AST-based style checks as warnings, built to zero false positives.
- `cprint`/`jsonPrint` and ANSI colour rendering in the console.
- Fixed: a `# -*- coding: utf-8 -*-` header broke the parse, the outline, go-to-definition and test discovery; the declaration is now neutralised without shifting any line or column.
- Fixed: the `tagchange` snippet named a non-existent `event.getTagPath()`.
- Fixed: a console ANSI reset left bold text coloured.

## [1.21.0] — 2026-09-07

feat: a Jython test framework — decorators, assertions, mocks, and a namespace per run.

- `@test`, `@skip`, `@cases`, `@beforeAll`/`@afterAll`/`@beforeEach`/`@afterEach`, `@timeout` (a budget, not an interrupt).
- Twelve assertions, each naming what it wanted and what it got.
- `mockTags`/`mockQuery` answer from a dict and record writes/calls; an unmocked read or query raises rather than returning `None`.
- A `skip` outcome, and re-run-failed-only.
- Each selected test module's source runs in a namespace private to the run, because importing returns the gateway's shared module object — a mock there would leak to every other user's scripts.
- `scriptide` (the test helper module) exists only during a run and is not importable outside one.

## [1.20.0] — 2026-09-07

feat: export and import code, in the Designer's own format.

- Right-click a script or package → Export, producing a Designer-compatible resource zip.
- Import lists the archive's contents, flags which resources already exist, and writes one push per resource.
- Every limit (traversal, per-entry/per-archive/total size, entry count, resource-type allowlist) is checked against the decompressed stream.
- Fixed: the first implementation built entry paths from `ResourcePath.getPath()`, which drops the module and type and makes the zip unimportable anywhere.
- `lastModification` is never carried across from the exporting gateway.

## [1.19.0] — 2026-09-07

fix: output written after an import was going to the gateway's console, not yours — plus a resizable, orientable console.

- Fixed: importing a project-library module moves the thread onto the platform's `PySystemState` and never restores it, so `print` and `sys.stdout.write` leaked to the gateway's own console from the first such import onward. Fixed with a private builtins table per run, restored in a `finally`.
- Console editor/output split is now a draggable divider, rows or columns, remembered as a proportional share.
- Fixed: the popped-out console showed a teal corner from the page glow leaking through unpadded chrome.
- Fixed: a document's own save briefly looked like somebody else's edit on the stale/pull UI; fixed by tracking in-flight saves and re-reading the tree before clearing that state.

## [1.18.0] — 2026-09-07

refactor: the compare-two-gateways feature is removed, and the split button is one you can see.

- Removed: the Compare view, `RemotePanel`, `RemoteGateways`, `RemoteClient`, `RemoteRouteHandler`, the `/api/remote/*` and `/api/scripts/digest` routes, the peer-or-session auth path, and the disposable second-gateway test rig.
- The test runner is unaffected.
- Split button now carries a label (`Split` / `Move left` / `Move right`) instead of a glyph alone.

## [1.17.0] — 2026-09-06

feat: two gateways side by side, and a Jython test runner.

- Compare view: pick a configured peer, see which bodies differ, open a differing one read-only beside your own. Read-only by construction — the client has no write path to a peer.
- Peers are named in `policy.properties`, never a client-supplied URL, to avoid a server-side request forgery primitive.
- A shared-secret token (`X-ScriptIDE-Remote-Token`) gates the peer-read surface; off unless configured, read-only, rejected under 24 characters.
- Test runner: discovers and runs Jython tests on the gateway, reporting pass/fail/error/elapsed/traceback/output; discovery is narrow by module-name convention.
- The decision to stay internal-only is recorded rather than assumed.
- Fixed: the peer gate originally covered the digest route only, leaving body reads open; a remote buffer could offer to overwrite the peer's file; the compare gesture could park the wrong pane.
- `scripts/testing/capture_readme_shots.py` retakes the README screenshots against whatever is deployed.
- A disposable second gateway (`dockers/peer.sh`) proves the Compare feature across two real machines and is destroyed after each run.

## [1.16.1] — 2026-09-06

feat: search that covers what the IDE actually edits, guards on the way out, and outstanding review items.

- Search, references and replace now cover gateway event scripts, Web Dev handlers/pages and named-query SQL, not just library scripts.
- A save that fails to parse asks once before writing.
- Rename a script, with call sites offered as a confirmed project-wide replace.
- Compare an override against its inherited parent chain, read-only.
- An "unused" report for top-level functions and classes nothing else names.
- Impact-before-save: a save removing or re-declaring a function lists its call sites first.
- Run history now survives a gateway restart, storing source and output per user.
- Tag change event scripts are fully editable (`paths`, `changeTypes`, `enabled`).
- The Administrator-role name is a policy key, not a hardcoded literal.
- Gateway event scripts show which are failing in the Problems panel (the SDK exposes no last-run/next-run data to build more on).
- Not done: two gateways side by side and a Jython test runner (shipped next release); internal/public status and a second-gateway proof are decisions, not code.

## [1.15.3] — 2026-09-05

feat: local save history, deprecation diagnostics, scope-aware checks, project-wide replace, and runtime errors in Problems.

- Local history: every save kept per user, including the pre-edit version, bounded and pruned; restore loads the buffer and never writes directly.
- Deprecated API calls now surface as a diagnostic, not just a hover note.
- Scope-aware checks flag `system.gui`/`system.nav` calls in contexts where the platform does not support them.
- Project-wide literal replace, written through the ordinary per-file save route.
- Problems panel gains a second list: runtime errors the gateway has actually logged, grouped by message.
- Fixed: local history was filed under the wrong data key; three new routes shipped with a hardcoded `/api/...` path instead of going through `apiUrl`; two new CSS classes collided with selectors the live suites count on.

## [1.14.4] — 2026-09-05

feat: diagnostics for every language the IDE opens, and the terminal keystroke bug root-caused.

- CSS, JavaScript, JSON, SQL and HTML documents now get error signalling, not just Python.
- Gateway write access is granted on the platform's `SESSION_WRITE` or the Administrator role, as a union.
- `terminal.docker` stays on by default.
- Terminal keyboard input, earlier marked "not root-caused" and removed from the suite, is confirmed working and restored — the earlier investigation never checked the socket itself.

## [1.13.0] — 2026-09-04

feat: undefined-name detection, ruler-to-line alignment, solid tooltips, a dedicated auth-error bar, stale-signature verification, and a collapsed Web Dev tree by default.

- `UnknownNames` reports a name bound nowhere in the module, excluding builtins and platform-injected names; tuned against the estate's own scripts to avoid false positives on script-library roots.
- The error ruler mark is now drawn on the line number itself rather than proportionally down the ruler.
- The hover tooltip uses a solid composited background instead of a glass film.
- A 401 on save now shows a dedicated bar saying the buffer is untouched, with sign-in and retry actions.
- A stale signature is verified once against the real bytes before the pull bar is raised, so a restart-only signature change does not trigger a false "pull" prompt.
- The Web Dev tree ships collapsed and remembers what you expand.

## [1.12.0] — 2026-09-04

fix: the status colours — three themes, not one.

- Three themes painted error/warning/success as a single hex or two near-identical greys.
- `pick_legible` now skips a candidate below a minimum chroma; `border.danger` is preferred over an amber "alarm-high" token for `--error`; status colours that resolved to one another by weight alone are now separated by hue.

## [1.11.0] — 2026-09-04

feat: the themes pass — colour in the grounds, the packs' own rails, and a syntax palette that distinguishes.

- Light theme grounds were nearly achromatic; raised to a visible chroma along each pack's own hue.
- The activity bar now takes a pack's own dark accent colour where the pack has one, instead of discarding it.
- Syntax highlighting separation is now scored on hue, weight and saturation together.
- The Run button's label no longer hardcodes white, which was unreadable on light-accent themes.

## [1.10.0] — 2026-09-04

feat: split editors — two scripts side by side.

- A second editor pane, toggled by a tab-strip button or Ctrl+\; a document moves between panes rather than duplicating.
- Draggable, remembered divider.
- Fixed: a 1px divider between flex children received no pointer events; widened to a 3px grab area, which also fixed the side-bar and panel dividers.

## [1.9.0] — 2026-09-04

feat: Web Dev's static resources — HTML, JavaScript and CSS, edited properly.

- Static (`text-resource`) Web Dev resources now open and save, with content-type-aware highlighting.
- Non-text data-key files (binary, oversized) are listed greyed rather than hidden.
- HTML, JavaScript, CSS and JSON editing surfaces alongside Python and SQL.
- Fixed: a static resource offered to add Python handlers to itself; the Jython language server ran over non-Python documents; only one tab per resource (not per file) tracked staleness.

## [1.8.10] — 2026-09-04

fix: the ruler marks the wrong line, closing a tab throws work away, and pull is missable.

- Ruler marks are now placed from CodeMirror's own layout rather than a line-count arithmetic approximation.
- Closing a dirty tab now asks, with Cancel / Discard / Save-and-close.
- A bar between the tab strip and the buffer now surfaces a pending pull for the active document.
- Escape now dismisses the conflict and close-confirmation dialogs.

## [1.8.7] — 2026-09-03

feat: the Designer's error ruler, with copy-to-clipboard on the mark and on every Problems row.

- An overview ruler beside the editor marks every problem line proportionally to the document, merging co-located problems and distinguishing severity by colour and width.
- Hover shows the parser's message with a Copy button; clicking jumps the caret and opens the Problems panel.
- Fixed: both Copy buttons silently did nothing over HTTP, because the async Clipboard API requires a secure context; replaced with an `execCommand('copy')` fallback that reports whether it actually worked.

## [1.8.5] — 2026-09-03

feat: a favicon, sidebar state that survives a view switch, and pull-from-gateway.

- A favicon, inlined as a data URI so the module works air-gapped.
- Pull from the gateway, per tab and for all at once, with a stale marker and a counted button; detection runs on focus, visibility and a 20s timer, and never replaces a buffer silently.
- Fixed: sidebar trees reset to default on every activity-bar view switch; each tree now keeps its open branches in `sessionStorage`.

## [1.8.4] — 2026-09-03

feat: the themes carry a material, not just a palette.

- Themes are now tiered (glass / soft / hard) by reading translucent-surface tokens from the pack itself, with translucent films, a lit ground gradient, and material-appropriate edge contrast.
- Fixed: native checkboxes and radios rendered in the browser default blue across all ten themes; the contrast sweep could not see alpha-composited surfaces and misjudged the glass pair as illegible.

## [1.7.2] — 2026-09-03

fix: the themes pass shipped geometry nobody could see.

- Radius and spacing clamp ceilings were set below where the packs actually live, collapsing most themes onto identical values; raised to span the packs' real range.
- Chrome bar heights now derive from `--control-height` instead of a hardcoded value in three files.
- `--row-height` now binds tree, palette, problems and outline rows consistently.
- Added a test asserting the ten themes yield enough distinct geometry signatures to catch this class of regression.

## [1.7.1] — 2026-09-03

Superseded within the hour by 1.7.2 — the clamp fix landed, then the row-padding half of the same defect was found.

## [1.7.0] — 2026-09-03

feat: named queries — the SQL and the Python that calls it, in one workspace.

- A Named Queries activity-bar view: folders, create, rename, delete, inherited/override badges.
- A SQL editor sharing the script editor's theme, gutters and byte-fidelity facets.
- Settings, Authoring and Testing tabs matching the Designer's own three concerns.
- Test run executes the draft (not the saved copy) through the prepared-statement route.
- Named queries appear in quick open, ranked with scripts.
- Fixed: a version-1 named query is unreadable by the platform itself; settings saves now repair it to version 2 without erasing the SQL.
- Theme geometry tokens (control/panel/row radius, marker width, row/control height, popup shadow, border colour, activity-bar background) are now taken from the packs, not just colour.

## [1.6.1] — 2026-09-02

fix: the console could not run a function or a class — every script with one raised NameError.

- `PrivateStateRunner` ran locals and globals as two separate dicts, so a function or class body could not see names the module itself had just defined. Fixed by running both in one dict.

## [1.6.0] — 2026-09-02

feat: the IDE navigates a project — go-to-definition, quick open, search, references and problems.

- Go to definition (F12/Ctrl-click) across files, silent on platform calls with no local source.
- Quick open (Ctrl+P), with `#` for project symbols.
- A Search view over project text search.
- Name-based references (Shift+F12), explicitly not type-aware, and labelled as such.
- A Problems panel over every open document's diagnostics.
- Fold gutter on files, go-to-line on Ctrl+G.
- The script tree ships collapsed and no longer lists Web Dev endpoints separately.
- `ETag` is now a quoted entity tag per RFC 9110; `If-Match` parsing is tolerant of `W/` and quoting.
- Fixed: a cross-file jump landed the caret on line 1 because the target CodeMirror view did not exist yet; fixed with a pending-reveal mechanism.

## [1.5.4] — 2026-09-02

feat: the project listing says where inherited scripts come from.

- `GET /api/projects` now carries `parent` and `inheritable` per project.

## [1.5.3] — 2026-09-02

fix: typed input never reached the terminal's shell, and closing it leaked a root shell.

- The hijacked Docker exec socket was wrapped in JDK stream adapters that share a lock between read and write, deadlocking input against the pump thread. Replaced with direct `SocketChannel` reads/writes using separate locks.

## [1.5.2] — 2026-09-02

fix: a terminal opened before its socket did, on a tab nothing else had used.

- `TermClient.open()` now defers its open frame to the transport's next connect event instead of sending on an unopened socket.

## [1.5.1] — 2026-09-02

fix: a stopped script poisoned its executor thread, and the next run on it was cancelled at once.

- `ScriptManager.interrupt` leaves the thread's frame/trace state pointing at a dead frame; `PrivateStateRunner` now snapshots and restores it around every run.

## [1.5.0] — 2026-09-02

fix: a socket that keeps listening, and a shell that actually dies.

- The exec frame handler no longer blocks the socket thread for the duration of a run; `started`/`output`/`finished` now arrive via callbacks, so Stop and every other frame are read promptly.
- Tracebacks are now unpacked from the structured payload instead of relying on client-invented field names.
- Docker exec resize now happens after attach, not before — the earlier order always timed out and silently skipped the resize.
- Closing a terminal now actively ends the shell: ETX/EOT/`exit`, then a root sweep that kills anything tagged with the terminal id, because the Docker Engine API has no "kill this exec".
- Policy switches (execution, terminal) are now read live from file/property/default instead of once at JVM start.
- An empty Project Library package no longer renders as an openable script; clicking an absent singleton event script opens a draft instead of writing a resource on click.
- `HintIndex` completion docs render the type name, not a raw data-class dump.

## [1.4.3] — 2026-09-02

fix: the Docker elevation route was never reachable, and the last terminal line was clipped.

- `SocketChannel.socket()` threw on a Unix-domain channel, making the Docker route report itself absent even when the socket was usable; timeouts now come from a watchdog that closes the channel instead.
- `FitAddon` did not subtract the fitted element's own padding, clipping the last terminal row; padding moved to the wrapper.
- The test rig is back on the stock Ignition image; the custom image and its Dockerfile are removed.

## [1.4.2] — 2026-09-02

feat: chrome sizing, one chrome row, and a Docker route to root.

- `--control-height` token applied across the toolbar's controls, fixing inconsistent heights and a Save button running into the border.
- The inheritance notice moved into the settings strip instead of its own row.
- A Docker-daemon exec route to root, with its own switch (`terminal.docker`) separate from sudo elevation.

## [1.4.1] — 2026-09-01

fix: Script Hint Scope is small, last on the strip, and silent.

- The control is now a small, unlabelled field at the trailing end of the editor header, matching the real Designer's footprint.

## [1.4.0] — 2026-09-01

feat: inherited scripts are read-only, and a root terminal.

- Inherited Project Library scripts are read-only until explicitly overridden, matching the real Designer's behaviour exactly (measured against it).
- The terminal elevates to root via `sudo -n` where the host already allows it; elevation happens inside the pty so the shell stays a process this JVM can signal.
- Script Hint Scope reordered to the Designer's own measured ordering (None · Designer · Gateway · All).

## [1.3.1] — 2026-09-01

Font rendering, measured side by side against VS Code.

- Removed `-webkit-font-smoothing: antialiased`, which is macOS advice and forces greyscale on Linux against the platform default.
- `ui-monospace` moved off the front of the mono font stack; alone it is not monospaced in Chrome on Linux.
- Code is now 14px at 1.4 line height, matching VS Code's split.

## [1.3.0] — 2026-09-01

feat: a terminal on the Gateway, a bottom panel, and Gateway Events measured against the real Designer.

- Terminal: a real shell on a real pseudo-terminal via `script(1)`, gated by Administrator + CSRF + same-origin with its own kill switch.
- A bottom dock panel holding Script Console and Terminal, plus the four VS Code layout glyphs.
- Startup/Shutdown/Update singleton scripts can now be created from the tree.
- Fixed: the two Glass Aurora theme variants were indistinguishable because the resolver fell through to a shared fallback token instead of lifting the pack's own accent.
- Fixed: `[hidden]` did not actually hide elements, because the user-agent rule lost to same-specificity app rules; forced globally.
- Fixed: Gateway Events tree order and singleton rendering did not match the real Designer; corrected against a measured reference.
- Typography: the UI font no longer comes from the theme pack.

## [1.2.0] — 2026-09-01

A VS Code-shaped shell, and Web Dev as a first-class view.

- Fixed: five of ten themes were illegible because neutrals were mapped from Perspective's semantic surface tokens rather than derived from the page colour; all ten now pass at 4.5:1.
- Fixed: a Web Dev endpoint's several tabs shared one language-server document, keyed only by path instead of by data key.
- Activity bar (Scripting / Web Dev / Search / Console), resizable and hideable panels.
- Web Dev as a full view: endpoints, methods, settings dialog, create/delete.
- Find and replace (Ctrl+F/Ctrl+H) in editor and console.
- Gateway event scripts can be created and deleted like the Designer's.

## [1.1.0] — 2026-09-01

Wiring the backend 1.0 had already built: Script Console, split panes and pop-out, an outline panel, create/delete scripts, a Designer-shaped tree, themes, gateway event settings.

- Fixed: an event-script folder resource was editable as if it were a script.
- Fixed: the first Run of a session always failed because the socket connects lazily.
- Fixed: themes did not apply, because `:root` and `[data-theme]` have identical specificity.
- Known limit: Tag Change settings are still refused; console output is not streamed.

## [1.0.0] — 2026-09-01

First complete release. Built and validated against Ignition 8.3.8.

- Editor: browser IDE served from the Gateway, file tree by script type, tabbed multi-file editing, CodeMirror 6, conflict dialog on concurrent edits.
- Resource editing: Project Library and Gateway event scripts, written through `ProjectManager.push()`, byte-identical to the Designer.
- Execution: run a buffer or selection with streamed output, structured traceback, best-effort Stop, per-user REPL console, per-execution audit.
- Language server: completions, signature help and hover over one authenticated WebSocket, sourced from the running gateway's own script registry.
- Navigation: go-to-definition through import bindings, outline, project-wide symbol search and text search.
- Diagnostics: syntax errors from the gateway's real Jython parser.
- Security: Administrator + session + CSRF + same-origin required for execution; no actor-string fallback; write routes type-gated to known script resources.
- Known limitations: no breakpoint debugging, no find-references, diagnostics are syntax-only, Perspective/Vision event scripts are not editable.
