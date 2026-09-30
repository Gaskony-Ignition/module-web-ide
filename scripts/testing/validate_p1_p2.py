#!/usr/bin/env python3
"""Live acceptance for P1 (byte-perfect resource writes) and P2 (execution).

These two checks are the ones the phases actually stand or fall on, and neither
can be proved by a unit test:

  P1  A script saved through the IDE must be byte-identical to what the real
      Designer writes - tabs preserved as tabs, and NO trailing newline. Verified
      by reading the bytes back off the gateway's filesystem with `cat -A`, not
      by trusting our own round trip.

  P2  Two scripts running at once must not see each other's output. Spike S1
      measured the ORIGINAL design leaking 22-25 lines between concurrent users;
      this asserts the replacement really does isolate them, against the live
      gateway rather than in theory.
"""
import os
import json
import subprocess
import time
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from gateway_session import CONFIG, GATEWAY_URL, login  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SPA = CONFIG.get("spa_path", "/data/scriptide/")
SOCKET = CONFIG.get("socket_path", "/system/scriptide")
CONTAINER = CONFIG.get("container_name", "ignition-module-testing")
PROJECTS_DIR = "/usr/local/bin/ignition/data/projects"

# Tabs, and deliberately NO trailing newline - exactly what the Designer writes.
PROBE_SOURCE = "def probe():\n\tvalues = [1, 2, 3]\n\tif values:\n\t\treturn sum(values)\n\treturn 0"
PROBE_PKG = "scriptide_probe"

results = []


def record(name, ok, detail):
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
        login(page)
        page.goto(GATEWAY_URL + SPA, wait_until="load", timeout=30000)

        session = page.evaluate(
            "async (spa) => (await (await fetch(spa + 'api/auth/session',"
            " {credentials:'include'})).json())", SPA)
        projects = page.evaluate(
            "async (spa) => (await (await fetch(spa + 'api/projects',"
            " {credentials:'include'})).json()).projects", SPA)
        # SI_PROJECT picks the project when the first mutable one is not
        # writable on disk (a project folder copied in as root, say).
        wanted = os.environ.get("SI_PROJECT")
        target = next((x for x in projects if x["mutable"] and (not wanted or x["name"] == wanted)), None)
        if not target:
            sys.exit("FAIL: no mutable project on this gateway to write into")
        project = target["name"]
        print(f"Validating against project '{project}'")

        # ---------- P1: write a script, then read the BYTES off disk ----------
        path = f"ignition/script-python/{PROBE_PKG}"
        encoded = urllib.parse.quote(path, safe="")
        # Read first to get the ETag. A modify without one is refused with 428 by
        # design - the optimistic-concurrency guard does not make an exception for
        # our own tooling, and it should not.
        write = page.evaluate(
            """async ([spa, enc, project, csrf, source]) => {
                 const url = spa + 'api/scripts/content/' + enc
                             + '?project=' + encodeURIComponent(project);
                 const existing = await fetch(url, {credentials:'include'});
                 const etag = existing.ok ? existing.headers.get('ETag') : null;
                 const headers = {'Content-Type':'application/json','X-CSRF-Token':csrf};
                 if (etag) { headers['If-Match'] = etag; }
                 const r = await fetch(url,
                   {method:'POST', credentials:'include', headers: headers,
                    body: JSON.stringify({source: source})});
                 return {status: r.status, body: await r.text(),
                         mode: etag ? 'modify' : 'create'};
               }""",
            [SPA, encoded, project, session.get("csrfToken"), PROBE_SOURCE])
        record("P1 write", write["status"] == 200,
               f"HTTP {write['status']} ({write['mode']}) {write['body'][:90]}")

        if write["status"] == 200:
            disk = f"{PROJECTS_DIR}/{project}/ignition/script-python/{PROBE_PKG}/code.py"
            # cat -A makes tabs (^I) and line ends ($) visible, so this cannot be
            # fooled by a normalising read.
            shown = subprocess.run(
                ["docker", "exec", CONTAINER, "sh", "-c", f"cat -A {disk}"],
                capture_output=True, text=True, timeout=60)
            raw = subprocess.run(
                ["docker", "exec", CONTAINER, "sh", "-c", f"cat {disk}"],
                capture_output=True, text=True, timeout=60)
            on_disk = raw.stdout
            print("      on-disk bytes (cat -A):")
            for line in shown.stdout.splitlines():
                print("        " + line)
            record("P1 tabs preserved", "^I" in shown.stdout and "        " not in on_disk,
                   "indentation is tabs, not spaces")
            record("P1 no trailing newline", not on_disk.endswith("\n"),
                   "file ends without a terminating newline, as the Designer writes it")
            record("P1 byte-identical", on_disk == PROBE_SOURCE,
                   "round trip is byte-for-byte" if on_disk == PROBE_SOURCE
                   else f"differs: sent {len(PROBE_SOURCE)}B, on disk {len(on_disk)}B")

            # ---------- the script must become importable ----------
            # The library rebuild is ASYNCHRONOUS: measured 01/09/2026, a freshly
            # written module is not importable immediately but is ~6s later, with no
            # project scan and no restart. So poll rather than asserting on the first
            # try - a single immediate check would report a false failure, and a
            # fixed sleep would either be flaky or waste time.
            deadline = time.time() + 30
            out = ""
            waited = 0.0
            while time.time() < deadline:
                run = run_script(page, project, session,
                                 f"import {PROBE_PKG}\nprint {PROBE_PKG}.probe()\n")
                out = (run.get("stdout") or "").strip()
                if out == "6":
                    break
                time.sleep(2)
                waited += 2
            record("P1 saved script is live", out == "6",
                   f"import {PROBE_PKG}; probe() -> {out!r} after ~{waited:.0f}s "
                   f"(no project scan, no restart)")

        # ---------- P2: concurrent isolation ----------
        # The exact shape of the S1 failure: two scripts, 500 tagged lines each.
        iso = page.evaluate(
            """async ([path, spa, project, csrf]) => {
                 const url = (location.protocol === 'https:' ? 'wss://' : 'ws://')
                             + location.host + path;
                 // stdout is accumulated from the `output` frames, which since
                 // 1.5.0 are the ONLY place it appears - `finished` carries empty
                 // stdout by contract. Gathering the live stream also makes this a
                 // stronger isolation test than reading a final buffer: a line
                 // that leaked between the two runs leaks as it is produced.
                 function runOne(tag) {
                   return new Promise((resolve) => {
                     const ws = new WebSocket(url);
                     let out = '';
                     const t = setTimeout(() => { try{ws.close();}catch(e){} 
                       resolve({tag, error:'timeout'}); }, 60000);
                     ws.onopen = () => ws.send(JSON.stringify({ch:'exec', msg:{
                       action:'run', project: project, csrfToken: csrf,
                       source: "for i in range(500):\\n    print '" + tag + "-%04d' % i\\n"}}));
                     ws.onmessage = (ev) => {
                       const f = JSON.parse(ev.data);
                       if (f.ch !== 'exec') return;
                       if (f.msg && f.msg.error) { clearTimeout(t); ws.close();
                         return resolve({tag, error: f.msg.error}); }
                       if (f.msg && f.msg.event === 'output') {
                         if (f.msg.stream === 'stdout') out += f.msg.text || '';
                         return;
                       }
                       if (f.msg && f.msg.event === 'finished') {
                         clearTimeout(t); ws.close();
                         return resolve({tag, stdout: out});
                       }
                     };
                   });
                 }
                 // Two SEPARATE sockets: one per "user", because the per-session
                 // limit deliberately allows only one run per connection.
                 return await Promise.all([runOne('AAA'), runOne('BBB')]);
               }""",
            [SOCKET, SPA, project, session.get("csrfToken")])

        for entry in iso:
            tag = entry.get("tag")
            if entry.get("error"):
                record(f"P2 isolation {tag}", False, entry["error"])
                continue
            lines = [l for l in entry.get("stdout", "").split("\n") if l.strip()]
            other = "BBB" if tag == "AAA" else "AAA"
            own = len([l for l in lines if l.startswith(tag + "-")])
            cross = len([l for l in lines if l.startswith(other + "-")])
            record(f"P2 isolation {tag}", cross == 0 and own == 500,
                   f"{own}/500 own lines, {cross} CROSSTALK lines "
                   f"(S1 measured 22-25 with the original design)")

        # ---------- P2: a traceback carries clickable frames ----------
        bad = run_script(page, project, session,
                         "def inner():\n    raise ValueError('boom')\n\ninner()\n")
        err = bad.get("error") or {}
        frames = err.get("frames") or []
        record("P2 traceback frames", err.get("type") == "ValueError" and len(frames) >= 2,
               f"type={err.get('type')} frames={len(frames)} "
               f"lines={[f.get('line') for f in frames]}")

        # ---------- cleanup ----------
        page.evaluate(
            """async ([spa, enc, project, csrf]) => {
                 const url = spa + 'api/scripts/content/' + enc + '?project='
                             + encodeURIComponent(project);
                 const existing = await fetch(url, {credentials:'include'});
                 const headers = {'Content-Type':'application/json','X-CSRF-Token':csrf};
                 const etag = existing.ok ? existing.headers.get('ETag') : null;
                 if (etag) { headers['If-Match'] = etag; }
                 await fetch(url, {method:'POST', credentials:'include', headers: headers,
                    body: JSON.stringify({source: '# removed by validate_p1_p2.py'})});
               }""",
            [SPA, encoded, project, session.get("csrfToken")])

        browser.close()

    print()
    failed = [n for n, ok, _ in results if not ok]
    if failed:
        print(f"VALIDATION: FAIL ({', '.join(failed)})")
        return 1
    print(f"VALIDATION: PASS ({len(results)} checks)")
    return 0


def run_script(page, project, session, source):
    """Run one script over the exec socket; return the finished frame plus stdout.

    stdout is GATHERED FROM THE `output` FRAMES, never read off `finished`.
    Since 1.5.0 `finished` carries empty stdout and stderr by contract - every
    line has already gone out as an `output` frame, and a client that rendered
    both would print the whole run twice. This suite was still reading
    `finished.stdout` and so reported 0 lines for every run from 1.5.0 to 1.6.0:
    the checks looked like an execution failure and were a stale reader.
    `deploy_gate.py` was fixed at the time and this file was not.
    """
    return page.evaluate(
        """async ([path, project, csrf, source]) => {
             const url = (location.protocol === 'https:' ? 'wss://' : 'ws://')
                         + location.host + path;
             return await new Promise((resolve) => {
               const ws = new WebSocket(url);
               let out = '';
               const t = setTimeout(() => resolve({error:{type:'timeout'}}), 40000);
               ws.onopen = () => ws.send(JSON.stringify({ch:'exec', msg:{
                 action:'run', project: project, csrfToken: csrf, source: source}}));
               ws.onmessage = (ev) => {
                 const f = JSON.parse(ev.data);
                 if (f.ch !== 'exec') return;
                 if (f.msg && f.msg.event === 'output') {
                   if (f.msg.stream === 'stdout') out += f.msg.text || '';
                   return;
                 }
                 if (f.msg && f.msg.event === 'finished') {
                   clearTimeout(t); ws.close();
                   resolve(Object.assign({}, f.msg, {stdout: out}));
                 } else if (f.msg && f.msg.error) {
                   clearTimeout(t); ws.close(); resolve({error:{type:f.msg.error}});
                 }
               };
             });
           }""",
        [SOCKET, project, session.get("csrfToken"), source])


if __name__ == "__main__":
    sys.exit(main())
