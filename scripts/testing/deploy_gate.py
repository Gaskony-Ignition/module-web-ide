#!/usr/bin/env python3
"""The single arbiter of "the Web IDE is deployed".

Never claim a deploy worked, never start live validation, and never tag a release
unless this prints PASS.

It exists because every cheaper signal lies. An install can report success while
the gateway keeps serving the previous module; the version string and the JS hash
are both stamped at BUILD time, so neither can tell you whether the code you just
wrote is the code now running.

Checks, all of which must pass:

  1. FRONTEND  the served index.html references the same hashed asset filename as
               the local build. Catches a stale bundle.
  2. VERSION   Config > Modules shows Web IDE at build.gradle.kts's version.
  3. AUTH      an authenticated browser session gets authenticated:true from
               /api/auth/session, with a username and a CSRF token.
  4. ROUTES    every GET route parsed out of ScriptIdeRouteRegistrar.java at RUN
               TIME answers as a mounted route. Never a hand-copied list: the
               point is to catch a route that exists in source but was never
               mounted, which checks 1-3 all pass straight through.
  5. SOCKET    an authenticated WebSocket to /system/scriptide completes a
               ping/pong round trip.

Check 5 is the one that earns its place at P0. Spike S1 answered every other
question about this design without a module, but could not answer whether
addServlet() resolves to /system/<alias> for a NEW alias — that needs a built
module. It is the last unverified assumption in the plan, and a servlet that
silently fails to register would leave checks 1-4 green.

Usage:
    SI_GATEWAY_CONFIG=$PWD/config.local.json \
    PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
      <venv>/python scripts/testing/deploy_gate.py
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from gateway_session import CONFIG, GATEWAY_URL, login  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
BUILT_INDEX = REPO / "web" / "build" / "generated-resources" / "mounted" / "index.html"
ROOT_BUILD = REPO / "build.gradle.kts"
SPA_PATH = CONFIG.get("spa_path", "/data/scriptide/")
SOCKET_PATH = CONFIG.get("socket_path", "/system/scriptide")

results = []


def record(name, ok, detail):
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")


def local_asset_hash():
    if not BUILT_INDEX.exists():
        return None
    m = re.search(r'assets/(index-[A-Za-z0-9_-]+\.js)', BUILT_INDEX.read_text())
    return m.group(1) if m else None


def declared_version():
    m = re.search(r'^version\s*=\s*"([\d.]+)"', ROOT_BUILD.read_text(), re.M)
    return m.group(1) if m else None


def main():
    expected_asset = local_asset_hash()
    expected_version = declared_version()
    if not expected_asset:
        sys.exit("FAIL: no local build to compare against. Run ./gradlew build first.")
    if not expected_version:
        sys.exit("FAIL: could not read version from build.gradle.kts")

    print(f"Gate: Web IDE {expected_version} on {GATEWAY_URL}")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(viewport={"width": 1600, "height": 1000}).new_page()
        login(page)

        # 1. FRONTEND — served bundle must be the one just built.
        page.goto(GATEWAY_URL + SPA_PATH, wait_until="load", timeout=30000)
        served = page.content()
        m = re.search(r'assets/(index-[A-Za-z0-9_-]+\.js)', served)
        served_asset = m.group(1) if m else None
        record("FRONTEND", served_asset == expected_asset,
               f"served {served_asset}, built {expected_asset}")

        # 2. VERSION — what the gateway believes it installed.
        # The grid paginates at 20 rows and this gateway runs 36 modules, so
        # reading the raw page text finds nothing and looks like a failed install.
        # Filter the grid instead, which is exact regardless of page size.
        page.goto(GATEWAY_URL + "/app/platform/system/modules", wait_until="load", timeout=30000)
        page.wait_for_selector("#modules-data-grid-global-search", timeout=20000)
        page.fill("#modules-data-grid-global-search", "Web IDE")
        page.wait_for_timeout(1500)
        grid_text = page.inner_text("body")
        shown = "Web IDE" in grid_text and expected_version in grid_text
        # ACTIVE is what "the gateway is actually running this" looks like; a
        # module can be present and FAULTED, which is not a successful deploy.
        active = "ACTIVE" in grid_text
        record("VERSION", shown and active,
               f"filtered grid: Web IDE {expected_version} "
               f"{'found' if shown else 'NOT FOUND'}, "
               f"{'ACTIVE' if active else 'not ACTIVE'}")

        # 3. AUTH — a real cookie session, not HTTP Basic (which creates no WebUiSession).
        page.goto(GATEWAY_URL + SPA_PATH, wait_until="load", timeout=30000)
        session = page.evaluate(
            "async () => { const r = await fetch('%sapi/auth/session',"
            " {credentials: 'include'}); return await r.json(); }" % SPA_PATH
        )
        record("AUTH", bool(session.get("authenticated")) and bool(session.get("csrfToken")),
               f"authenticated={session.get('authenticated')} user={session.get('username')} "
               f"canExecute={session.get('canExecute')}")

        # 4. ROUTES — parsed from source at run time, never hand-copied.
        try:
            import route_probe
            routes = route_probe.parse_get_routes()
        except Exception as e:  # noqa: BLE001
            routes = []
            record("ROUTES", False, f"could not parse the registrar: {e}")
        if routes:
            # parse_get_routes() yields (const_name, path_template) pairs.
            unmounted = []
            probed = 0
            for _name, route in routes:
                if "*" in route or ":" in route:
                    continue  # splat / parameterised routes are not probeable bare
                probed += 1
                status, body = page.evaluate(
                    "async (u) => { const r = await fetch(u, {credentials:'include'});"
                    " return [r.status, (await r.text()).slice(0,120)]; }",
                    GATEWAY_URL + SPA_PATH.rstrip("/") + route,
                )
                # Only the catch-all's own 404 body means "never mounted" — a
                # handler's own 404 is a legitimate answer from a mounted route.
                if status == 404 and "Unknown API endpoint" in body:
                    unmounted.append(route)
            record("ROUTES", not unmounted and probed > 0,
                   f"{probed} of {len(routes)} route(s) probed, unmounted: {unmounted or 'none'}")

        # 5. SOCKET — the P0 question S1 could not answer without a module.
        ws_result = page.evaluate(
            """async (path) => {
                 const url = (location.protocol === 'https:' ? 'wss://' : 'ws://')
                             + location.host + path;
                 return await new Promise((resolve) => {
                   let done = false;
                   const finish = (v) => { if (!done) { done = true; resolve(v); } };
                   const t = setTimeout(() => finish({ok:false, why:'timeout after 10s'}), 10000);
                   let ws;
                   try { ws = new WebSocket(url); }
                   catch (e) { clearTimeout(t); return finish({ok:false, why:'constructor threw: '+e}); }
                   ws.onopen = () => ws.send(JSON.stringify({ch:'ping'}));
                   ws.onmessage = (ev) => {
                     clearTimeout(t);
                     let parsed; try { parsed = JSON.parse(ev.data); }
                     catch (e) { return finish({ok:false, why:'unparseable frame: '+ev.data}); }
                     const msg = parsed && parsed.msg;
                     finish({ok: !!(msg && msg.pong), why: JSON.stringify(parsed).slice(0,200)});
                     ws.close();
                   };
                   ws.onerror = () => { clearTimeout(t); finish({ok:false, why:'upgrade failed - servlet not registered at '+path}); };
                 });
               }""",
            SOCKET_PATH,
        )
        record("SOCKET", bool(ws_result.get("ok")),
               f"{SOCKET_PATH} -> {ws_result.get('why')}")

        # 6. EXECUTE - one assertion that proves the whole spine at once:
        # auth + socket + CSRF + thread pool + Jython + private-state capture.
        # If this passes, execution genuinely works end to end.
        exec_js = """
            async ([path, spa]) => {
              const r = await fetch(spa + 'api/auth/session', {credentials:'include'});
              const session = await r.json();
              const pr = await fetch(spa + 'api/projects', {credentials:'include'});
              const projects = (await pr.json()).projects || [];
              const target = projects.find(p => p.mutable) || projects[0];
              if (!target) return {ok:false, why:'no project to run against'};
              const url = (location.protocol === 'https:' ? 'wss://' : 'ws://')
                          + location.host + path;
              return await new Promise((resolve) => {
                let done = false;
                const finish = (v) => { if (!done) { done = true; resolve(v); } };
                const t = setTimeout(() => finish({ok:false, why:'timeout after 25s'}), 25000);
                const ws = new WebSocket(url);
                ws.onopen = () => ws.send(JSON.stringify({ch:'exec', msg:{
                    action:'run', project: target.name,
                    csrfToken: session.csrfToken,
                    source: 'print 1+1\\n'}}));
                // Since 1.5.0 output is STREAMED as `output` frames and the
                // `finished` frame's stdout is empty by contract, so the gate
                // gathers the stream and asserts on the whole.
                let streamed = '';
                ws.onmessage = (ev) => {
                  const f = JSON.parse(ev.data);
                  if (f.ch !== 'exec') return;
                  if (f.msg && f.msg.error) { clearTimeout(t); ws.close();
                    return finish({ok:false, why:'server said: ' + f.msg.error}); }
                  if (f.msg && f.msg.event === 'output' && f.msg.stream === 'stdout') {
                    streamed += f.msg.text || '';
                  }
                  if (f.msg && f.msg.event === 'finished') {
                    clearTimeout(t); ws.close();
                    const out = (streamed + (f.msg.stdout || '')).trim();
                    return finish({ok: out === '2',
                      why: 'stdout=' + JSON.stringify(out) + ' ok=' + f.msg.ok
                           + ' project=' + target.name});
                  }
                };
                ws.onerror = () => { clearTimeout(t); finish({ok:false, why:'socket error'}); };
              });
            }
        """
        exec_result = page.evaluate(exec_js, [SOCKET_PATH, SPA_PATH])
        record("EXECUTE", bool(exec_result.get("ok")),
               f"print 1+1 -> {exec_result.get('why')}")

        browser.close()

    print()
    failed = [name for name, ok, _ in results if not ok]
    if failed:
        print(f"GATE: FAIL ({', '.join(failed)})")
        print("Do NOT claim this is deployed, and do not start live validation.")
        return 1
    print(f"GATE: PASS ({len(results)} checks) — Web IDE {expected_version} is live.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
