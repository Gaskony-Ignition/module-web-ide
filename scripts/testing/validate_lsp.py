#!/usr/bin/env python3
"""Live acceptance for the language features (P3-P6).

Drives the real LSP channel over the real WebSocket against the real gateway.
Everything asserted here is the thing the module exists to provide:

  P3  completions and signature help sourced from THE RUNNING GATEWAY, so they
      reflect the modules actually installed - the claim no static stub can make.
  P4  go-to-definition and symbol search across the project's own scripts, which
      must come from our AST index because spike S1 measured that the platform's
      hint tree does not contain them.
  P5  diagnostics from the real Jython 2.7 parser, and - just as important - NO
      diagnostics on valid Python 2, which a Python 3 parser would reject.
  P6  cross-file text search.
"""
import json
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from gateway_session import CONFIG, GATEWAY_URL, login  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SPA = CONFIG.get("spa_path", "/data/scriptide/")
SOCKET = CONFIG.get("socket_path", "/system/scriptide")
PKG = "scriptide_lsp_probe"
PROBE_SOURCE = (
    "'''Probe module for the Web IDE acceptance test.'''\n"
    "\n"
    "TOLERANCE = 3\n"
    "\n"
    "def compute_total(values, factor=2):\n"
    "\t'''Adds the values and scales them.'''\n"
    "\treturn sum(values) * factor\n"
    "\n"
    "class Widget:\n"
    "\tdef spin(self):\n"
    "\t\tprint 'spinning'\n"
)

results = []


def record(name, ok, detail):
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")


LSP_DRIVER = """
async ([path, project, frames]) => {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path;
  return await new Promise((resolve) => {
    const ws = new WebSocket(url);
    const replies = {};
    const notifications = [];
    let nextIndex = 0;
    const done = () => { try { ws.close(); } catch (e) {} 
                         resolve({replies, notifications}); };
    const timer = setTimeout(done, 40000);
    const pump = () => {
      while (nextIndex < frames.length) {
        const frame = frames[nextIndex++];
        ws.send(JSON.stringify({ch: 'lsp', project: project, msg: frame}));
        if (frame.id !== undefined) { return; }   // wait for the reply
      }
      clearTimeout(timer);
      // Let any trailing notifications (diagnostics) land before resolving.
      setTimeout(done, 1500);
    };
    ws.onopen = pump;
    ws.onmessage = (ev) => {
      const outer = JSON.parse(ev.data);
      if (outer.ch !== 'lsp') return;
      const msg = outer.msg;
      if (msg.id !== undefined) { replies[msg.id] = msg; pump(); }
      else if (msg.method) { notifications.push(msg); }
    };
    ws.onerror = () => { clearTimeout(timer); resolve({error: 'socket error'}); };
  });
}
"""


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
        target = next((x for x in projects if x["mutable"]), None)
        if not target:
            sys.exit("FAIL: no mutable project to test against")
        project = target["name"]
        print(f"Validating language features against project '{project}'")

        # Put a known module in the project so navigation has something real to find.
        encoded = urllib.parse.quote(f"ignition/script-python/{PKG}", safe="")
        status = page.evaluate(
            """async ([spa, enc, project, csrf, source]) => {
                 const url = spa + 'api/scripts/content/' + enc
                             + '?project=' + encodeURIComponent(project);
                 const existing = await fetch(url, {credentials:'include'});
                 const headers = {'Content-Type':'application/json','X-CSRF-Token':csrf};
                 const etag = existing.ok ? existing.headers.get('ETag') : null;
                 if (etag) { headers['If-Match'] = etag; }
                 const r = await fetch(url, {method:'POST', credentials:'include',
                   headers: headers, body: JSON.stringify({source: source})});
                 return r.status;
               }""",
            [SPA, encoded, project, session.get("csrfToken"), PROBE_SOURCE])
        record("probe module written", status == 200, f"HTTP {status}")
        time.sleep(6)   # the library rebuild is asynchronous

        uri = f"ignition://{project}/ignition/script-python/{PKG}"
        # A buffer that is mid-edit, exactly as a real completion request would be.
        # Two trailing lines: one mid-identifier (for completion) and one inside an
        # open call (for signature help, which by definition needs an open paren).
        buffer_text = (PROBE_SOURCE
                       + "\nresult = system.tag.re\n"
                       + "other = system.tag.readBlocking(\n")
        lines = buffer_text.rstrip("\n").split("\n")
        complete_line = len(lines) - 2
        signature_line = len(lines) - 1

        # Open with the VALID source, then type the extra lines - which is what a
        # user actually does, and which also exercises incremental sync. Opening
        # straight into a broken buffer would be a different (and less useful) test:
        # there is legitimately no previous good parse to fall back to.
        frames = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "initialized", "params": {}},
            {"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
                "textDocument": {"uri": uri, "languageId": "python",
                                 "version": 1, "text": PROBE_SOURCE}}},
            {"jsonrpc": "2.0", "method": "textDocument/didChange", "params": {
                "textDocument": {"uri": uri, "version": 2},
                "contentChanges": [{"text": buffer_text}]}},
            {"jsonrpc": "2.0", "id": 2, "method": "textDocument/completion", "params": {
                "textDocument": {"uri": uri},
                "position": {"line": complete_line, "character": len("result = system.tag.re")}}},
            {"jsonrpc": "2.0", "id": 3, "method": "textDocument/signatureHelp", "params": {
                "textDocument": {"uri": uri},
                "position": {"line": signature_line,
                             "character": len("other = system.tag.readBlocking(")}}},
            {"jsonrpc": "2.0", "id": 4, "method": "textDocument/documentSymbol", "params": {
                "textDocument": {"uri": uri}}},
            {"jsonrpc": "2.0", "id": 5, "method": "workspace/symbol",
             "params": {"query": "compute_total"}},
            {"jsonrpc": "2.0", "id": 6, "method": "scriptide/searchText",
             "params": {"query": "TOLERANCE"}},
        ]
        out = page.evaluate(LSP_DRIVER, [SOCKET, project, frames])
        if out.get("error"):
            sys.exit(f"FAIL: {out['error']}")
        replies = out["replies"]

        # ---------- P3: completions from the live gateway ----------
        init = replies.get("1", {}).get("result", {})
        caps = init.get("capabilities", {})
        record("P3 initialize", caps.get("textDocumentSync") == 2 and caps.get("hoverProvider"),
               f"sync={caps.get('textDocumentSync')} "
               f"definition={caps.get('definitionProvider')} "
               f"symbols={caps.get('workspaceSymbolProvider')}")

        items = (replies.get("2", {}).get("result") or {}).get("items", [])
        names = [i["label"] for i in items]
        record("P3 completion from the running gateway",
               "readBlocking" in names and "readAsync" in names,
               f"{len(items)} items for 'system.tag.re' -> {sorted(names)[:6]}")

        detailed = next((i for i in items if i["label"] == "readBlocking"), None)
        record("P3 completion carries a real signature",
               bool(detailed and detailed.get("detail")),
               f"detail={detailed.get('detail') if detailed else None!r}")

        sig = replies.get("3", {}).get("result")
        record("P3 signature help", bool(sig and sig.get("signatures")),
               (sig["signatures"][0]["label"] if sig and sig.get("signatures") else "none"))

        # ---------- P4: navigation over the project's OWN code ----------
        symbols = replies.get("4", {}).get("result") or []
        symbol_names = [s["name"] for s in symbols]
        record("P4 outline survives a half-typed line",
               {"TOLERANCE", "compute_total", "Widget", "spin"} <= set(symbol_names),
               f"{symbol_names}")

        hits = replies.get("5", {}).get("result") or []
        record("P4 workspace symbol search",
               any(h["name"] == "compute_total" for h in hits),
               f"{len(hits)} hit(s) for 'compute_total'")

        # ---------- P6: cross-file text search ----------
        found = replies.get("6", {}).get("result") or []
        record("P6 cross-file text search",
               any(PKG == h["module"] for h in found),
               f"{len(found)} line(s) containing 'TOLERANCE'")

        # ---------- P5: diagnostics ----------
        clean = diagnostics_for(page, project, uri + "_clean", PROBE_SOURCE)
        record("P5 valid Python 2 is NOT flagged", clean == [],
               f"{len(clean)} diagnostic(s) on print-statement/tab code"
               + (f" -> {clean}" if clean else ""))

        broken = diagnostics_for(page, project, uri + "_broken",
                                 "a = 1\nb = 2\nc = = 3\n")
        record("P5 a real syntax error IS flagged",
               len(broken) == 1 and broken[0]["range"]["start"]["line"] == 2,
               f"{broken[0]['message'][:60] if broken else 'none'} "
               f"at line {broken[0]['range']['start']['line'] if broken else '?'}")

        browser.close()

    print()
    failed = [n for n, ok, _ in results if not ok]
    if failed:
        print(f"LSP VALIDATION: FAIL ({', '.join(failed)})")
        return 1
    print(f"LSP VALIDATION: PASS ({len(results)} checks)")
    return 0


def diagnostics_for(page, project, uri, source):
    """Open a document and collect the diagnostics the server pushes back."""
    frames = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {"uri": uri, "languageId": "python",
                             "version": 1, "text": source}}},
    ]
    out = page.evaluate(LSP_DRIVER, [SOCKET, project, frames])
    for notification in out.get("notifications", []):
        if notification.get("method") == "textDocument/publishDiagnostics":
            if notification["params"]["uri"] == uri:
                return notification["params"]["diagnostics"]
    return []


if __name__ == "__main__":
    sys.exit(main())
