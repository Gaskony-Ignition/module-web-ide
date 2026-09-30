#!/usr/bin/env python3
"""Backend route probe — the half of the deploy gate the JS-hash/version
checks cannot cover.

Why this exists (20/08/2026): the gate's FRONTEND check (served bundle hash
== built bundle hash) and JAVA check (Modules page version string == built
version) both PASSED while a brand-new Java route, `GET /api/tags/traits`
(milestone 0.90.0), still answered "Unknown API endpoint" — the gateway had
not restarted onto the jar that registers it. Both existing checks are
stamped at build time and neither one asks the gateway "does this specific
route exist"; they only ask "is the gateway running SOME build at this
version, serving SOME bundle at this hash". A route added in the same release
those checks say is live can still be entirely unmounted.

This module is GENERATED FROM THE SOURCE, not hand-maintained, so it cannot
go stale the way a hand-copied route list would:

  1. `parse_route_constants()` regex-parses every `ROUTE_*` string literal out
     of `common/.../ScriptIdePaths.java`.
  2. `parse_get_routes()` regex-parses `gateway/.../ScriptIdeRouteRegistrar.java`
     for every `routes.newRoute(ScriptIdePaths.ROUTE_X)...mount()` block and
     keeps only the ones with NO explicit `.method(HttpMethod.POST/DELETE/PUT)`
     — RouteGroup's default mount method is GET (see the registrar's own
     Javadoc on why POST must always be explicit), and only `/api/...` paths
     (the `/*` SPA catch-all is deliberately excluded — see below).
  3. `build_request_path()` turns each route template into an actual request:
     a `:path` URL segment (ResourceRouteHandler/NamedQueryRouteHandler's
     `:path` binds to `req.getParameter("path")` via the route framework, so
     any single harmless segment satisfies ROUTING — the handler's own
     validation of the segment's *content* runs only after the route already
     matched, which is all a "does this route exist" probe needs) gets a
     placeholder segment; routes whose handler 400s without a query parameter
     (`project`, tag `path`) get a harmless one — `_wd_scratch_` is this
     module's own disposable scratch project (`ensure_scratch_project.py`),
     `[default]` is the default tag provider's root.

**What "route exists" means here.** `SpaAssetRouteHandler` is mounted LAST as
the catch-all (`/*` matches everything); when the router reaches it because no
more specific `/api/...` route matched, it recognises the `/api/` prefix and
returns `404 "Unknown API endpoint"` instead of the SPA shell (see that
class's `handle()` — this is deliberate, so an API client gets a clean 404
instead of an HTML page it can't parse as JSON). That exact response — 404
with that exact body — is the ONLY thing that means "this route isn't
mounted", because it is the ONE response a specific handler can never produce
itself (every handler either succeeds or fails through its own status/body).
Everything else — 200, 400 (bad param), 401/403 (auth/access), or a 404 with
ANY other body (a handler's own "no such project/resource/tag") — means a
real handler answered, i.e. the route is live. This deliberately does NOT
grade whether a route's *answer* is correct; that is what the validate-*.py
scripts and the frontend/version checks are for.
"""

import re
from pathlib import Path
from urllib.parse import urlencode

MODULE_ROOT = Path(__file__).resolve().parents[2]
PATHS_JAVA = (
    MODULE_ROOT / "common" / "src" / "main" / "java" / "com" / "gaskony"
    / "scriptide" / "common" / "ScriptIdePaths.java"
)
REGISTRAR_JAVA = (
    MODULE_ROOT / "gateway" / "src" / "main" / "java" / "com" / "gaskony"
    / "scriptide" / "gateway" / "routes" / "ScriptIdeRouteRegistrar.java"
)

_ROUTE_CONST_RE = re.compile(r'public static final String (ROUTE_\w+)\s*=\s*"([^"]*)"\s*;')
_MOUNT_ALIAS_RE = re.compile(r'public static final String MOUNT_ALIAS\s*=\s*"([^"]*)"\s*;')
# Non-greedy: one routes.newRoute(...)...mount(); block at a time. DOTALL so
# the multi-line builder chains (accessControl/handler on their own lines)
# are captured, not just the first line.
_MOUNT_BLOCK_RE = re.compile(
    r'routes\.newRoute\(ScriptIdePaths\.(ROUTE_\w+)\)(.*?)\.mount\(\);', re.S
)

# The catch-all is registered via ROUTE_SPA_CATCH_ALL ("/*"), which is a
# TEXT_HTML SPA-shell route, not a JSON API endpoint — it always matches
# something, so probing it proves nothing about a specific handler and is
# excluded on principle here even though the "/api/" filter below would
# already exclude it.
_EXCLUDE = {"ROUTE_SPA_CATCH_ALL"}

# `_wd_scratch_` is this module's own disposable, write-safe scratch project
# (see ensure_scratch_project.py) — duplicated here as a literal, rather than
# importing that module, so this probe has no dependency on docker-exec
# helpers it has no business pulling in. If the scratch project's name ever
# changes, update both.
SCRATCH_PROJECT = "_wd_scratch_"

# Harmless query params for routes whose handler 400s without one. Only
# routes that actually need something appear here — everything else is
# probed with a bare query string (or none), which every handler here
# already tolerates (falls back to "list everything" or 400s cleanly).
QUERY_PARAMS = {
    "ROUTE_RESOURCES": {"project": SCRATCH_PROJECT},
    "ROUTE_RESOURCE_BY_PATH": {"project": SCRATCH_PROJECT},
    "ROUTE_TAG_BROWSE": {"path": "[default]"},
    # TagRouteHandler#config requires a path with BOTH a parent and an item
    # name (a bare provider root 400s "not a bare provider or empty path");
    # a nonexistent leaf under the root exercises that branch without
    # depending on any tag actually existing.
    "ROUTE_TAG_CONFIG": {"path": "[default]RouteProbe"},
    "ROUTE_TAG_TRAITS": {"path": "[default]"},
    "ROUTE_NAMED_QUERIES": {"project": SCRATCH_PROJECT},
    "ROUTE_NAMED_QUERY_BY_PATH": {"project": SCRATCH_PROJECT},
    "ROUTE_STYLE_CLASSES": {"project": SCRATCH_PROJECT},
    # ScriptAttributesRouteHandler#read 400s without a project, exactly like
    # the resource routes. ROUTE_SCRIPT_HINTS needs nothing — it takes no
    # parameters at all (getHintsTree() has no scope argument), and neither
    # does ROUTE_SECURITY_LEVELS (getSecurityLevelsConfig() takes none either),
    # so both are probed bare and are absent from this table deliberately.
    "ROUTE_SCRIPT_ATTRIBUTES": {"project": SCRATCH_PROJECT},
}

# Routes whose registered PATTERN contains a ":path" URL segment (as opposed
# to a "path" QUERY parameter, which is a different thing — e.g. tag routes
# read a "path" query param with no ":path" segment at all). The registrar's
# Javadoc confirms first-match-wins ordering makes any single segment here
# safe to probe with: it can never collide with a literal route like
# "/api/resources/rename", which is registered and matched BEFORE this one.
PATH_SEGMENT_ROUTES = {
    "ROUTE_RESOURCE_BY_PATH",
    "ROUTE_NAMED_QUERY_BY_PATH",
    "ROUTE_SCRIPT_ATTRIBUTES",
}
PATH_SEGMENT_PLACEHOLDER = "route-probe"

# The exact body SpaAssetRouteHandler.handle() sends for an unmatched
# "/api/..." path. Only THIS response means "route not mounted" — see the
# module docstring.
NOT_FOUND_BODY = "Unknown API endpoint"


def parse_route_constants() -> dict:
    """{const_name: literal_string_value} for every ROUTE_* in ScriptIdePaths.java."""
    if not PATHS_JAVA.exists():
        raise SystemExit(f"FAIL: no ScriptIdePaths.java at {PATHS_JAVA}")
    text = PATHS_JAVA.read_text()
    constants = {m.group(1): m.group(2) for m in _ROUTE_CONST_RE.finditer(text)}
    if not constants:
        raise SystemExit(f"FAIL: no ROUTE_* constants found in {PATHS_JAVA} — regex is stale?")
    return constants


def parse_mount_alias() -> str:
    text = PATHS_JAVA.read_text()
    m = _MOUNT_ALIAS_RE.search(text)
    if not m:
        raise SystemExit(f"FAIL: no MOUNT_ALIAS found in {PATHS_JAVA}")
    return m.group(1)


def parse_get_routes() -> list:
    """[(const_name, path_template), ...] for every GET-mounted /api/ route,
    in registration order, generated from ScriptIdeRouteRegistrar.java —
    never hand-copied."""
    if not REGISTRAR_JAVA.exists():
        raise SystemExit(f"FAIL: no ScriptIdeRouteRegistrar.java at {REGISTRAR_JAVA}")
    registrar_text = REGISTRAR_JAVA.read_text()
    constants = parse_route_constants()

    routes = []
    seen = set()
    for m in _MOUNT_BLOCK_RE.finditer(registrar_text):
        name, body = m.group(1), m.group(2)
        if name in _EXCLUDE or name in seen:
            continue
        if re.search(r'HttpMethod\.(POST|DELETE|PUT)', body):
            continue  # not a GET mount — the registrar's default is GET
        path = constants.get(name)
        if path is None:
            raise SystemExit(
                f"FAIL: registrar mounts ScriptIdePaths.{name}, but no such "
                f"constant was parsed from {PATHS_JAVA} — probe generator is stale."
            )
        if not path.startswith("/api/"):
            continue  # not a JSON API endpoint (e.g. a future non-api GET route)
        seen.add(name)
        routes.append((name, path))
    return routes


def build_request_path(name: str, path_template: str) -> str:
    """Relative request path (under /data/<mount-alias>) with query string,
    for the given route constant name."""
    path = path_template
    if name in PATH_SEGMENT_ROUTES:
        path = path.replace(":path", PATH_SEGMENT_PLACEHOLDER)
    params = QUERY_PARAMS.get(name, {})
    if params:
        path = f"{path}?{urlencode(params)}"
    return path


def route_missing(status: int, body: str) -> bool:
    """True only for the ONE response that means 'not mounted' — see module docstring."""
    return status == 404 and NOT_FOUND_BODY in (body or "")


PROBE_FETCH_JS = """
async ({ path }) => {
  try {
    const resp = await fetch(path, { credentials: 'include' });
    const text = await resp.text();
    return { status: resp.status, body: text.slice(0, 300) };
  } catch (e) {
    return { status: -1, body: String(e) };
  }
}
"""


def probe_backend_routes(page, data_base: str) -> list:
    """Probe every GET /api/ route with an authenticated fetch (via the
    already-logged-in `page`) and return
    [(name, path_template, request_path, status, body, exists), ...].

    Every request goes through the SAME authenticated browser session
    `deploy_gate.py` already logged in (`login()` + `assert_authenticated()`
    upstream of this call) — a route that exists but 401s for an
    unauthenticated caller would otherwise be indistinguishable from one that
    genuinely isn't mounted.
    """
    results = []
    for name, path_template in parse_get_routes():
        request_path = data_base + build_request_path(name, path_template)
        outcome = page.evaluate(PROBE_FETCH_JS, {"path": request_path})
        status, body = outcome["status"], outcome["body"]
        exists = not route_missing(status, body)
        results.append((name, path_template, request_path, status, body, exists))
    return results
