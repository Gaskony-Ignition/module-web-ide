# Named Queries — design and contract

Everything in §1 was **measured** off the platform jars and a running 8.3.8
gateway, not designed from memory. Do not widen the vocabulary below from
recollection — if it is not measured here, check the gateway.

## Why

Named queries and the Python that calls them are one piece of work — a
script calling `system.db.runNamedQuery("Orders/Insert", …)` and the query it
names are edited together. The Designer puts them in different workspaces;
this module puts them side by side.

## 1. What the platform holds (measured)

Everything in this section came from building a `NamedQuery`, putting it
through `NamedQuery.toResource`, and reading the resulting resource back,
plus a sweep of every named-query resource already on a gateway. The numbers
below are what came back, not what the class file suggested.

Resource type `ignition/named-query`, one folder per query, path
`ignition/named-query/<Folder>/<Sub>/<Name>`. One file, **`query.sql`**, and the
attributes below. `NamedQuery.CURRENT_RESOURCE_VERSION` is **2**,
`LEGACY_RESOURCE_VERSION` is **1**.

### 1.1 The attribute keys — `NamedQuery$ResourceKeys`, read off the running gateway

| Key | Java field / type | Notes |
| --- | --- | --- |
| `type` | `Type` enum | names **`Query`**, **`ScalarQuery`**, **`UpdateQuery`** (`toString()` gives "Scalar Query" — that is the label, not the value) |
| `enabled` | boolean | defaults **true** on a fresh `NamedQuery` |
| `database` | String | connection name; empty = the project default. The literal **`{}`** (`NamedQuery.DATABASE_PARAM_OPTION`) means "take the connection from the `Database` parameter", whose identifier is `database` (`DATABASE_PARAM_IDENTIFIER`) |
| `fallbackEnabled` / `fallbackValue` | boolean / String | |
| `useMaxReturnSize` / `maxReturnSize` | boolean / long | defaults false / 100 |
| `cacheEnabled` | boolean | Java field is `cachingEnabled`; the KEY is `cacheEnabled` |
| `cacheAmount` | int | default 1 |
| `cacheUnit` | `TimeUnits` enum | **`MS` `SEC` `MIN` `HOUR` `DAY` `WEEK` `MONTH` `YEAR`** — eight, not seven, and not `java.util.concurrent.TimeUnit`. Default `SEC` |
| `autoBatchEnabled` | boolean | |
| `syntaxProvider` | String | written only when set; a Designer-written query on this rig carries `"class com.adbs.syntax.SQLiteSyntaxProvider"` |
| `permissions` | `List<ZoneRoleRequirement>` | `[{zone, role}]`. A fresh `NamedQuery` holds ONE requirement with null zone and role, which serialises as the empty object `{}`; the Designer writes `{"zone":"","role":""}` |
| `parameters` | `List<Parameter>` | see 1.2 |

**`description` is NOT an attribute.** `toResource` writes it to the resource's
top-level `documentation` field — verified both on the built resource
(`getDocumentation()` returned the string) and on disk, where a real
Designer-written query carries `"documentation": "…"` beside `"version": 2` and
nothing named `description` inside `attributes`. See 1.5 for the asymmetry this
creates.

The full attributes object `toResource` produced for a query with every field
set, verbatim:

```json
{"useMaxReturnSize":true,"autoBatchEnabled":true,"fallbackValue":"0",
 "maxReturnSize":1000,"cacheUnit":"MIN","type":"Query","enabled":true,
 "cacheAmount":30,"cacheEnabled":true,"database":"Postgres_Test",
 "fallbackEnabled":true,"permissions":[{}],
 "parameters":[{"type":"Parameter","identifier":"v","sqlType":7},
               {"type":"QueryString","identifier":"qs","sqlType":7},
               {"type":"Database","identifier":"db","sqlType":7}]}
```

`toResource` throws `NullPointerException` on a `NamedQuery` whose `type` or
`query` is null — the default constructor leaves both null, so both must be set
before serialising.

### 1.2 Parameters — the third enum is `Parameter`, not `Value`

`NamedQuery$Parameter` has three fields: `type` (`ParameterType`), `identifier`
(String), `sqlType` (`DataType`).

**`ParameterType.values()` is `Database`, `QueryString`, `Parameter`.** There is
no constant named `Value`: `ParameterType.Parameter.toString()` returns
`"Value"`, which is the Designer's LABEL, exactly as `Type.ScalarQuery.toString()`
returns "Scalar Query" — the wire vocabulary is the NAME, not the label.
`Value` is accepted on the way in as a documented alias for `Parameter`; the
server always emits `Parameter`.

`NamedQuery.PARAMETER_TYPES` — the ten a parameter may use, read off the running
gateway with their int values: `Int1`=0, `Int2`=1, `Int4`=2, `Int8`=3, `Float4`=4,
`Float8`=5, `Boolean`=6, `String`=7, `DateTime`=8, `ByteArray`=20.
**There is no `Date`.** (`DataType` itself has 22 constants — `Text`, `DataSet`,
the array types — but only these ten are legal on a named-query parameter.)

The registered `Parameter$GsonAdapter` writes `type` as the enum NAME and
`sqlType` as **`DataType.getIntValue()` — an integer**. Confirmed by writing one
through `toResource` and reading it back (the JSON above), and again against a
Designer-written resource, which carries exactly the same shape.

A hand-built resource that instead carries
`{"identifier":"x","dataType":"String"}` or `"dataType":"Date"` is not merely
ignored — see 1.5.

### 1.3 The serialisers — use them, never hand-build

```java
public static Consumer<ResourceBuilder> toResource(NamedQuery q)
public static NamedQuery fromResource(Resource r, XMLDeserializer d) throws Exception
```

**A version-2 resource needs no deserializer**: `fromResource(resource, null)`
round-trips every field measured above. The deserializer argument only matters
for the legacy `data.bin` path, and even there it makes no difference —
passing a real one from `GatewayContext.createDeserializer()` gives
byte-identical results to passing null. The gateway routes therefore pass
null and do not need a context for reads.

`toResource` also sets the resource's version to 2, its application scope to 7,
`overridable` true and `restricted` false.

### 1.4 Byte fidelity of `query.sql`

`toResource` writes `getQuery()` as UTF-8 and does nothing else — measured:

- `"SELECT :v AS echoed"` → 19 bytes, `'SELECT :v AS echoed'`,
  hex `53454c454354203a76204153206563686f6564`. **No trailing newline was added.**
- `"SELECT 1\n"` → 9 bytes, `'SELECT 1\n'`. **A trailing newline was preserved.**
- `""` → the `query.sql` data key is still present, 0 bytes.

So the same rule as scripts: write the text the user typed, add nothing, strip
nothing. `NamedQueryByteFidelityTest` asserts it.

### 1.5 A `"version": 1` named query is DEAD, and that is the real trap

A hand-written query left at version 1 is worse than mis-keyed — it does not run.

`fromResource` on a version-1 resource returns a **blank** `NamedQuery`
(`type` null, `query` null, `database` `""`, no parameters), whatever its
attributes say, and it does so with a real `XMLDeserializer` as well as with
null: the legacy branch reads `data.bin`, which a hand-written resource does not
have, and the attributes are never looked at. That is not a reading quirk on our
side — it is how the platform itself loads them:

```
system.db.runNamedQuery("ResourceBoard/Availability/GetScheduleTypes", {})
  java.lang.NullPointerException: Cannot invoke "NamedQuery$Type.equals(Object)"
  because the return value of "NamedQuery.getType()" is null
```

All 37 named queries in `Whiteboard` are in that state. So the guessed-key lesson
generalises: it is not only that `dataType` and `Date` are keys the platform never
reads, it is that a resource stamped `"version": 1` is not read at all.

Stamping version 2 onto that same resource does not rescue it either — the
parameter adapter then throws, which is the proof that `type` is required and is
read as the enum name:

```
NamedQuery$Parameter$GsonAdapter.deserialize(NamedQuery.java:386)
  NullPointerException: Cannot invoke "JsonElement.getAsString()" because the
  return value of "JsonObject.get(...)" is null
```

The consequence for this module: a legacy resource must still OPEN (its
`query.sql` is real and readable), its settings read back as the platform sees
them — empty — and the settings response says `version` and `legacy` so the UI
can say why. Saving settings rewrites it through `toResource`, which stamps
version 2 and makes it work.

### 1.6 The description asymmetry

`toResource` writes `description` to `documentation`. `fromResource` reads
`description` from the ATTRIBUTES. So a description written by the platform's own
writer does not come back through the platform's own reader — measured both ways:
`getDocumentation()` returned it, `fromResource(...).getDescription()` returned
null, and adding a `description` attribute by hand made `fromResource` return it.

This module reads the description from `getDocumentation()`, falling back to the
`description` attribute when one is present, and writes it only through
`toResource`. Do not "fix" this by hanging a `description` attribute on the
resource: that is the hand-built-attribute failure mode this whole document
exists to avoid.

## 2. The HTTP contract

Mirrors the script routes — same auth gate (`SessionSecurity`), same CSRF, same
quoted `ETag` / tolerant `If-Match`, same 428 (no base) / 409 (stale) / 404.
Reads are open to any authenticated user; every write and the test-run need
Administrator.

**`<path>` is the project-relative query path** — `Folder/Sub/Name`, exactly the
string `system.db.runNamedQuery` takes — percent-encoded into one route segment
(slashes become `%2F`). It carries **no `ignition/named-query/` prefix**, unlike
the script routes, because the type here is fixed and the client needs the
runnable path anyway. Every route and every example below uses that form.

| Route | Purpose |
| --- | --- |
| `GET /api/named-queries?project=P` | listing: `{project, mutable, queries:[…]}` — see below |
| `GET /api/named-queries/content/Orders%2FInsert?project=P` | `text/plain` SQL from the `query.sql` data key, `ETag` header. Reads the DATA KEY, not `NamedQuery.getQuery()`, so a legacy query still opens |
| `POST /api/named-queries/content/Orders%2FInsert?project=P` | body `{sql, settings?}`; `If-Match` required for a modify, absent for a create; `{ok, signature}` |
| `DELETE /api/named-queries/content/Orders%2FInsert?project=P` | `If-Match` required; 428 without. A folder takes its children with it |
| `GET /api/named-queries/settings/Orders%2FInsert?project=P` | `{path, signature, version, legacy, origin, owner, mutable, settings, databases, editable, vocabulary}` |
| `POST /api/named-queries/settings/Orders%2FInsert?project=P` | body `{settings}` + `If-Match`; unknown keys are a 400, never dropped; `{ok, signature}` |
| `POST /api/named-queries/rename?project=P` | body `{path, newPath, baseSignature?}` — see the rename rules |
| `POST /api/named-queries/test?project=P` | body `{path, parameters, sql?, settings?}` |

### The listing

```json
{"project":"P","mutable":true,"queries":[
  {"path":"Orders/Insert","name":"Insert","folder":"Orders","signature":"…",
   "version":2,"isFolder":false,"legacy":false,"origin":"local","owner":"P",
   "type":"Query","database":"Postgres_Test","enabled":true}]}
```

Folders are implied by paths, as in the Designer. A folder resource
(`dataKeys: []`) lists as `isFolder: true` exactly like scripts and carries none
of the query fields. `type`, `database` and `enabled` are published on EVERY
query row, legacy or not — on a legacy row they are the platform's defaults,
which is the honest answer because they are what the gateway itself sees.

### The settings object

```json
{"type":"Query","enabled":true,"database":"Postgres_Test","description":"…",
 "fallbackEnabled":false,"fallbackValue":"","useMaxReturnSize":false,
 "maxReturnSize":100,"cacheEnabled":false,"cacheAmount":1,"cacheUnit":"SEC",
 "autoBatchEnabled":false,"syntaxProvider":"","permissions":[{"zone":"","role":""}],
 "parameters":[{"type":"Parameter","identifier":"v","sqlType":"String"}]}
```

Enum **names** on the wire, the platform's own representation on disk — the
server converts through the enum in both directions and never writes an attribute
by hand:

- `type`: `Query` · `ScalarQuery` · `UpdateQuery`
- `parameters[].type`: `Database` · `QueryString` · `Parameter`. `Value` is
  accepted on input as a documented alias for `Parameter` (§1.2) and is never
  emitted.
- `parameters[].sqlType`: `Int1` `Int2` `Int4` `Int8` `Float4` `Float8` `Boolean`
  `String` `DateTime` `ByteArray`. A NAME on the wire, an int on disk. `Date` is
  a 400, and so is the key `dataType`.
- `cacheUnit`: `MS` `SEC` `MIN` `HOUR` `DAY` `WEEK` `MONTH` `YEAR`

Anything outside a vocabulary is a 400 that names the offending value and lists
what is allowed. An unknown settings KEY is a 400 too — a key the platform never
reads is how a resource comes to look right and behave wrongly. `vocabulary` on
the settings read carries all four lists, so the UI never hardcodes them.

**One exception to the naming rules, and it is inverted:** a `Database` parameter
must be named exactly `database` (`NamedQuery.DATABASE_PARAM_IDENTIFIER`).
`NamedQuery.isValidParamName("database")` returns FALSE — the platform reserves
it — and yet that is precisely what the Designer names the connection selector.
So the reserved name is REQUIRED for that one kind and refused for every other.

`editable` is the ALLOWLIST a settings write enforces: a key not in it is a 400.
It is non-empty for every named query, because every settings key this release
knows about is editable. (An empty `editable` would mean "no allowlist, every key
accepted" — that state does not occur here and no client should special-case it.)

A settings write is a PARTIAL update: only the keys present are applied, onto the
`NamedQuery` parsed from the current resource, which is then written back through
`toResource`. That is what preserves fields this release does not edit (the syntax
provider, the named theme) instead of blanking them, and it makes the response
object safe for a client to echo back unchanged. `description` is read from the
resource documentation and written through `toResource` — see §1.6.

### Creating a query

`POST …/content/<path>` with no `If-Match` creates. The new query lands on the
platform's defaults, PINNED by the server rather than inherited from the
constructor (`NamedQueryCodecTest.createDefaultsArePinned` fails if one moves):

| | |
| --- | --- |
| `type` | `Query` |
| `enabled` | `true` |
| `database` | `""` — the project default |
| `cacheEnabled` / `cacheAmount` / `cacheUnit` | `false` / `1` / `SEC` |
| `fallbackEnabled` / `fallbackValue` | `false` / `""` |
| `useMaxReturnSize` / `maxReturnSize` | `false` / `100` |
| `autoBatchEnabled` | `false` |
| `permissions` | one row, `{"zone":"","role":""}` |
| `parameters` | `[]` |

The create answers `{ok, signature}` — the signature of the resource that now
exists, so the client can save again without re-reading.

`settings` may ride along with `sql` on ANY content write, create or modify. The
editor's Ctrl+S saves both, and doing it in one push against one signature is the
only way the two cannot disagree: two requests means the second races the
signature the first just changed, and the user sees a spurious conflict on their
own save.

### Renaming

A rename is a create at the destination and a delete at the source in ONE push —
either the whole move lands or none of it does. Every destination is checked for a
collision before anything is pushed. What the path names decides the rest:

- **A query.** `If-Match` REQUIRED, as for a delete. Answers `{ok, signature}`.
- **A folder** — whether it is an implied folder (no resource at that path, at
  least one query beneath it) or a stored folder resource. `If-Match` is NOT
  required, and cannot be: named-query folders exist because query paths contain
  slashes, so most have no resource and therefore no signature to match against.
  Demanding one would make renaming a folder impossible rather than safe. Answers
  `{ok, moved:[{from, to, signature}]}`, one row per resource moved, so the client
  can retarget every open tab in one pass.

Moving a folder into itself is a 400; a destination that already exists is a 409.

### Legacy (version-1) queries

A version-1 resource is unreadable by the gateway (§1.5). This module surfaces
that rather than hiding it, and never repairs it behind the user's back:

- the listing and the settings read carry `legacy: true` and the platform's
  defaults. A read is a read — nothing is rewritten.
- a SAVED test-run is refused with a 409 that names the fix.
- **a settings POST is what upgrades it.** `toResource` stamps
  `CURRENT_RESOURCE_VERSION`, so any settings save rewrites the resource at
  version 2 and the query becomes runnable. The write path does NOT short-circuit
  on "nothing changed" — posting the settings back unedited is a valid repair and
  is what the client does. `NamedQueryByteFidelityTest.toResourceUpgradesALegacyBuilder`
  and `NamedQueryRouteHandlerTest.settingsSaveRepairsALegacyQuery` pin both halves.
- the SQL survives the repair. `fromResource` returns a null query for a legacy
  resource, so the write path falls back to the `query.sql` data key — without
  that, the repair would erase the user's SQL.

### The test-run

`{path, parameters, sql?, settings?}`, Administrator only. It is arbitrary SQL
against a live database, so it goes through `ExecutionService` — the same policy
gate, the same audit line, the same bounded pool and the same Stop as the console.

Two paths, and which one runs depends on whether `sql` is present:

- **No `sql`** — runs the SAVED resource through `system.db.runNamedQuery`, the
  platform's own path and the one whose behaviour the user is ultimately testing.
  Refused (409) if the query is legacy or disabled.
- **`sql` present** — runs the DRAFT through `runPrepQuery` /
  `runScalarPrepQuery` / `runPrepUpdate`, chosen by `settings.type`, against
  `settings.database` or the project default (a `Database` parameter's value wins
  over both). With `settings` too it needs no saved resource at all, so a
  never-saved query can be tested. **A draft run is NOT refused for a legacy or
  disabled query** — it does not go through the resource, and being able to test a
  fix before saving it is the entire point.

The draft path does the `:identifier` → `?` conversion that `runNamedQuery` would
otherwise do inside the platform. `Parameter` references become positional `?` in
the order they occur (so a repeated identifier is bound once per occurrence);
`QueryString` references are substituted into the SQL as TEXT, which is the
platform's semantic for them and an injection point by design — it is why this
route is Administrator-only; a `Database` reference inside the SQL is a 400. The
scanner skips a `:` inside a single-quoted literal (doubled quotes included) and
treats `::` as PostgreSQL's cast, and an identifier is the maximal run of letters,
digits and underscores — so `:id` and `:identifier` are distinct rather than one
being a prefix match of the other. `NamedQuerySqlTest` asserts each of those.

The generated Jython is a CONSTANT in both paths: the path, the SQL, the argument
list, the connection, the type and the row cap are seeded into the execution's
locals and the result comes back through that same namespace as a JSON string.
Nothing the user typed is concatenated into Python.

Parameter values arrive as JSON and are coerced in Java by the parameter's
declared `sqlType` before they go anywhere near the map:

| `sqlType` | accepted JSON | becomes |
| --- | --- | --- |
| `Int1` `Int2` `Int4` | number, whole-valued decimal, or a numeric string | `Integer` |
| `Int8` | as above | `Long` |
| `Float4` | number or numeric string | `Float` |
| `Float8` | number or numeric string | `Double` |
| `Boolean` | boolean, or `"true"`/`"false"` | `Boolean` |
| `String` `ByteArray` | any primitive | `String` |
| `DateTime` | ISO-8601 with `Z`, with an offset, or without one (gateway zone), or epoch-millis | `java.util.Date` |

A value that does not parse is a 400 naming the identifier, the declared type and
the value; a fractional number against an integral type is refused rather than
rounded. JSON null passes through as a null binding, on every type.

Responses — `type` and `elapsedMs` are on EVERY shape, success or failure, because
without the type a null scalar and an empty grid are the same response:

- Query — `{ok:true, type:"Query", columns:[{name, type}], rows:[[…]], rowCount, elapsedMs}`
  plus `truncatedAt:500` when the result was longer than the 500-row cap.
  `rowCount` is the TRUE row count; `rows` is what fitted.
- ScalarQuery — `{ok:true, type:"ScalarQuery", value, elapsedMs}`
- UpdateQuery — `{ok:true, type:"UpdateQuery", affected, elapsedMs}`
- failure — `{ok:false, type, elapsedMs, error:{…}}`, the console's own structured
  traceback object from `TracebackFormatter`, so the UI reuses the console's renderer.
- refused — 403 when execution is disabled by policy, 409 when the caller already
  has a run in flight or the query cannot run, 503 while the module is shutting
  down, 504 on the execution timeout.

Cell values are JSON: nulls stay null, numbers and booleans stay themselves, a
`java.util.Date` becomes an ISO-8601 string, and anything else is stringified.

### Inheritance

Origin/owner/inheritance follow the script rules exactly: a read resolves through
the inheritance-merged collection so an inherited query opens and carries
`origin: inherited`; a write uses the own-project lookup, so saving against an
inherited query creates the local override — starting from the parent's settings,
so the override keeps its parameters rather than reverting to defaults. A delete
or a rename of a query this project does not own is a 404, not a silent edit of
the parent.

## 3. The UI

A third side-bar view, **Named Queries**, on the activity bar (the
`ActivityBar` comment has said since 1.3.0 that this is why it is a view, not a
tree section). Folders, create (`Folder/Name` in the dialog, like the
Designer's), rename, delete. Opens a tab like a script tab; the tab strip does
not care what is in it.

The editor for a query is the Designer's three tabs, measured off 8.3.8:

- **Settings** — Type, Description, Database (dropdown of the gateway's
  connections + "default"), Enabled, Caching (enabled, amount, unit), Fallback
  (enabled, value), Max Return Size (enabled, size), Auto-batch, Security
  (zone/role rows).
- **Authoring** — the parameter table (type, identifier, sql type) above the SQL
  editor (CodeMirror `@codemirror/lang-sql`, same byte-fidelity facets, same
  theme). Ctrl+S saves SQL and settings together against one ETag.
- **Testing** — one input per parameter, typed by its `sqlType`, a Run button,
  and the result: a grid for Query, a value for Scalar, a count for Update, the
  console's own traceback block for a failure.

Quick open lists queries beside scripts. Search does not cover SQL in 1.7.0
(the index is scripts only) and the Search view says so in its status line.

Python completion: inside `system.db.runNamedQuery(` the first string argument
completes to the project's query paths (E3), because that is the join this
whole batch is for.

## 4. Deliberately out of scope for 1.7.0

- A UI for the syntax provider or the named theme. The API round-trips the
  syntax provider (a settings write is partial, so an unedited one survives) but
  no screen offers it; the named theme is not carried at all, because
  `toResource` does not write it.
- A SQL LSP: no completion, no diagnostics beyond the database's own error on
  test-run.
- Cross-file search over SQL.
