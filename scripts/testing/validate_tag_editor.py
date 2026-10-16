#!/usr/bin/env python3
"""End-to-end validation of the Designer-style tag editor: every tag route, the
Tags side-bar tree, the property/JSON editor tabs and the layout, driven the way
a user does it in a real browser at 1366x640 and 1920x1080.

Sections (E2E_ONLY=A,P,B,C,D,E,F,G selects some; the default is all):
  A  API: every route, signature/409, reset-by-removal, model, rename/move/copy,
     import/export round trip, CSRF, no session, audit lines
  P  policy: execution switched off in policy.properties (restored exactly)
  B  Tags tree UI: expand/collapse, live values, polling, every context-menu
     item, keyboard, multi-select, drag and drop, disabled items
  C  Editor UI: property form, JSON tab, save, reset, alarms, history, scripts,
     parameters, dirty/close, conflict, retarget on rename/move, close on delete
  D  Layout: no page scroll and no stray scroll bar at both sizes, screenshots
  E  Console + Query as editor-area tabs: state survives, pop-out, split, outline
  F  Split-pane tag editing: two tags, one per pane, both forms render, both save
  G  Theme sweep: every theme with a UDT-member tag open in Properties

Every API check runs through the SAME Playwright page `deploy_gate.py` logs in
with. Fixtures are `ZZ_e2e_*` under [default] and [default]_types_ and nothing
else on the gateway is touched. This suite creates the fixtures it destroys:
it removes anything named ZZ_e2e_* before it starts and again in `finally`.

Drag and drop: Playwright's real mouse (down, move, up) is used, which makes
Chromium fire native HTML5 dragstart/dragover/drop. Ctrl is held through the
keyboard so the drop carries ctrlKey. If the native path does not fire, the
suite says so and falls back to dispatching the events with a DataTransfer.

Usage:
    export SI_GATEWAY_CONFIG=$PWD/config.local.json PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright
    .venv/bin/python validate_tag_editor.py [screenshot-dir]
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from gateway_session import CONFIG, GATEWAY_URL, assert_authenticated, login  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SPA = CONFIG.get("spa_path", "/data/scriptide/").rstrip("/")
CONTAINER = CONFIG.get("container_name")
POLICY_FILE = "/usr/local/bin/ignition/data/modules/scriptide/policy.properties"
PROVIDER = "default"
ROOT = f"[{PROVIDER}]"
TYPES = f"{ROOT}_types_"
PFX = "ZZ_e2e_"
F = PFX + "f"
FP = ROOT + F
UDT = PFX + "Motor"
UDT_PATH = f"{TYPES}/{UDT}"
DEST = PFX + "dest"
DESTP = ROOT + DEST
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / "web-ide-e2e"
ONLY = set(filter(None, os.environ.get("E2E_ONLY", "").upper().split(",")))
RUN_START = time.time()

JS_FETCH = """async ([method, url, body, csrf]) => {
  const headers = {'Content-Type': 'application/json'};
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const r = await fetch(url, {method, credentials: 'include', headers,
    body: body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))});
  let j = null, t = null;
  try { t = await r.text(); j = JSON.parse(t); } catch (e) {}
  return {status: r.status, json: j, text: t};
}"""

# Every element whose computed overflow is auto/scroll and whose content really
# overflows, or that reserves room for a scroll bar. The caller whitelists.
JS_SCROLL_AUDIT = """() => {
  const out = [];
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
    + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || el.clientWidth === 0 && el.clientHeight === 0) continue;
    const ys = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    const xs = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    const barY = el.offsetWidth - el.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) > 1;
    const barX = el.offsetHeight - el.clientHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth) > 1;
    const overY = ys && el.scrollHeight > el.clientHeight;
    const overX = xs && el.scrollWidth > el.clientWidth;
    if (overY || overX || barY || barX) {
      out.push({el: name(el), overY, overX, barY, barX, sh: el.scrollHeight, ch: el.clientHeight,
                sw: el.scrollWidth, cw: el.clientWidth});
    }
  }
  const d = document.documentElement;
  return {items: out, page: {y: d.scrollHeight - d.clientHeight, x: d.scrollWidth - d.clientWidth,
                             by: document.body.scrollHeight - document.body.clientHeight}};
}"""

# The scroll surfaces that are meant to scroll: the tag tree's rows, the
# property form, the script tree, and CodeMirror's own scroller (the JSON /
# script editing surface). Anything else is a stray bar.
SCROLL_WHITELIST = ("tag-tree-rows", "tag-form", "file-tree", "cm-scroller")

results = []


def record(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + ("" if ok else f"  -- {str(detail)[:400]}"))


def want(section):
    return not ONLY or section in ONLY


def until(cond, timeout=15.0, step=0.15):
    """Poll `cond` until it returns truthy; return that value (or the last falsy one)."""
    end = time.time() + timeout
    val = None
    while time.time() < end:
        try:
            val = cond()
        except Exception:  # noqa: BLE001 - a flaky read is just "not yet"
            val = None
        if val:
            return val
        # Through Playwright, not time.sleep: the sync API only delivers page
        # events (request listeners) while it is being called.
        if C.page is not None:
            C.page.wait_for_timeout(step * 1000)
        else:
            time.sleep(step)
    return val


def atomic(name, data_type="Int4", value=0, **extra):
    return {"name": name, "tagType": "AtomicTag", "valueSource": "memory",
            "dataType": data_type, "value": value, **extra}


class Ctx:
    page = None
    csrf = ""
    context = None


C = Ctx()


def call(method, path, body=None, token=True):
    tok = C.csrf if (method == "POST" and token is True) else (token if isinstance(token, str) else None)
    return C.page.evaluate(JS_FETCH, [method, SPA + path, body, tok])


def q(path):
    from urllib.parse import quote
    return quote(path, safe="")


def create(base, config, collision="Overwrite"):
    return call("POST", "/api/tags/create", {"basePath": base, "json": json.dumps(config), "collision": collision})


def delete(*paths):
    return call("POST", "/api/tags/delete", {"paths": list(paths)})


def read_values(*paths):
    r = call("POST", "/api/tags/read", {"paths": list(paths)})
    return (r["json"] or {}).get("values", [])


def edit(path):
    r = call("GET", "/api/tags/edit?path=" + q(path))
    if r["status"] != 200:
        return None
    j = r["json"]
    j["local_obj"] = json.loads(j["local"])
    j["resolved_obj"] = json.loads(j["resolved"])
    return j


def save(path, obj, signature):
    return call("POST", "/api/tags/save", {"path": path, "json": json.dumps(obj), "signature": signature})


def browse(path):
    r = call("GET", "/api/tags/browse?path=" + q(path))
    return (r["json"] or {}).get("children", []) if r["status"] == 200 else None


def names(path):
    return [c["name"] for c in browse(path) or []]


def exists(path):
    return edit(path) is not None


def norm(node):
    """A config with its children in name order: the platform does not promise child order."""
    if isinstance(node, dict):
        out = {k: norm(v) for k, v in node.items()}
        if isinstance(out.get("tags"), list):
            out["tags"] = sorted(out["tags"], key=lambda t: t.get("name", ""))
        return out
    if isinstance(node, list):
        return [norm(v) for v in node]
    return node


def cleanup():
    """Remove everything this suite could have made, and nothing else."""
    for base in (ROOT, TYPES):
        for kid in browse(base) or []:
            if kid["name"].startswith(PFX):
                delete(f"{base}/{kid['name']}" if not base.endswith("]") else base + kid["name"])


def make_fixture():
    """The shared tag set the API and UI sections start from."""
    cleanup()
    r = create(TYPES, {"name": UDT, "tagType": "UdtType",
                       "parameters": {"unit": {"dataType": "String", "value": "rpm"}},
                       "tags": [atomic("Speed", "Float8", 3.5), atomic("Run", "Boolean", False)]}, "Abort")
    assert r["json"]["ok"], r["text"]
    r = create(ROOT, {"name": F, "tagType": "Folder", "tags": [
        atomic("a1", "Int4", 1),
        atomic("dup1", "Int4", 2),
        {"name": "m1", "tagType": "UdtInstance", "typeId": UDT, "tags": [{"name": "Speed", "value": 7.5}]},
        {"name": "sub", "tagType": "Folder", "tags": [atomic("leaf", "Int4", 9)]},
    ]}, "Abort")
    assert r["json"]["ok"], r["text"]


# ======================================================================
# main
# ======================================================================

def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1366, "height": 640}, accept_downloads=True)
        try:
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=GATEWAY_URL)
        except Exception:  # noqa: BLE001
            pass
        page = context.new_page()
        login(page)
        session = assert_authenticated(page)
        C.page, C.csrf, C.context = page, session["csrfToken"], context
        page.on("dialog", lambda d: d.accept())  # a stray browser dialog must never hang the run
        cleanup()
        try:
            if want("A"):
                api_checks()
            if want("P"):
                policy_checks()
            if any(want(x) for x in "BCDEFG"):
                make_fixture()
                page.goto(GATEWAY_URL + SPA + "/", wait_until="load")
                page.wait_for_selector(".activity-bar", timeout=20000)
            if want("B"):
                tree_checks()
            if want("C"):
                editor_checks()
            if want("D"):
                layout_checks()
            if want("E"):
                tool_tab_checks()
            if want("F"):
                split_tag_checks()
            if want("G"):
                theme_checks()
            screenshot_checks()
        except BaseException:
            try:
                page.screenshot(path=str(SHOTS / "failure.png"))
                print("failure screenshot:", SHOTS / "failure.png")
                print("tabs:", tabs(), "dialogs:", page.locator("[role=dialog],[role=alertdialog]").count())
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            cleanup()
            left = [n for n in names(ROOT) + names(TYPES) if n.startswith(PFX)]
            record("fixtures are gone after cleanup", not left, left)
            browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    for name in failed:
        print("  FAILED:", name)
    return 1 if failed else 0


# ======================================================================
# A. API
# ======================================================================

def api_checks():
    print("A. API")
    make_fixture()

    # ---- providers, browse
    r = call("GET", "/api/tags/providers")
    record("providers lists the default provider", PROVIDER in (r["json"] or {}).get("providers", []), r["text"])
    kids = browse(FP) or []
    by = {k["name"]: k for k in kids}
    record("browse returns each child with name, hasChildren, objectType, dataType",
           {"a1", "m1", "sub"} <= set(by) and all({"name", "hasChildren", "objectType", "dataType"} <= set(k) for k in kids),
           json.dumps(kids)[:300])
    record("browse types the instance UdtInstance (expandable) and the folder Folder",
           by["m1"]["objectType"] == "UdtInstance" and by["m1"]["hasChildren"] and by["sub"]["objectType"] == "Folder", json.dumps(by)[:300])
    record("browse of _types_ types the definition UdtType",
           any(k["name"] == UDT and k["objectType"] == "UdtType" for k in browse(TYPES) or []))
    record("browse of an unknown provider is a 404", call("GET", "/api/tags/browse?path=%5BNoSuchProvider_zz%5D")["status"] == 404)
    for bad in ["", "%5Bunclosed", "%20"]:
        record(f"browse with bad path '{bad}' is a 400", call("GET", "/api/tags/browse?path=" + bad)["status"] == 400)

    # ---- read / write / config
    w = call("POST", "/api/tags/write", {"path": FP + "/a1", "value": 42})
    v = read_values(FP + "/a1")
    record("write then read back an Int4", w["json"]["ok"] is True and v and v[0]["value"] == 42 and v[0]["good"], f"{w['text']} {v}")
    w = call("POST", "/api/tags/write", {"path": FP + "/nosuch", "value": 1})
    record("a write to a missing tag reports not ok", w["status"] == 200 and w["json"]["ok"] is False, w["text"])
    record("a write with no value is a 400", call("POST", "/api/tags/write", {"path": FP + "/a1"})["status"] == 400)
    record("a read with no paths is a 400", call("POST", "/api/tags/read", {"paths": []})["status"] == 400)
    c = call("GET", "/api/tags/config?path=" + q(FP))
    cfg = json.loads((c["json"] or {}).get("json", "{}"))
    record("config of a folder returns its recursive JSON", cfg.get("tagType") == "Folder" and len(cfg.get("tags", [])) == 4, c["text"][:200])
    record("config with no path is a 400", call("GET", "/api/tags/config")["status"] == 400)

    # ---- edit
    a = edit(FP + "/a1")
    record("edit of an atomic tag: local, resolved, 64-hex signature, tagType, not inherited, not a member",
           a and a["tagType"] == "AtomicTag" and re.fullmatch(r"[0-9a-f]{64}", a["signature"])
           and a["isInherited"] is False and a["udtMember"] is False and a["inherited"] == {}
           and a["local_obj"]["valueSource"] == "memory" and a["resolved_obj"] == a["local_obj"], json.dumps(a)[:300])
    record("edit's signature is stable across two reads", edit(FP + "/a1")["signature"] == a["signature"])
    inst = edit(FP + "/m1")
    record("edit of a UDT instance: UdtInstance, typeId local, inherited carries the definition's parameters",
           inst["tagType"] == "UdtInstance" and inst["local_obj"]["typeId"] == UDT
           and inst["inherited"].get("parameters", {}).get("unit", {}).get("value") == "rpm", json.dumps(inst)[:400])
    spd = edit(FP + "/m1/Speed")
    record("edit of an overridden member: udtMember and isInherited, local holds only the override",
           spd["udtMember"] is True and spd["isInherited"] is True and spd["local_obj"].get("value") == 7.5
           and "dataType" not in spd["local_obj"], json.dumps(spd)[:400])
    record("...inherited carries the definition's value and dataType; resolved has the override over them",
           spd["inherited"].get("value") == 3.5 and spd["inherited"].get("dataType") == "Float8"
           and spd["resolved_obj"].get("value") == 7.5 and spd["resolved_obj"].get("dataType") == "Float8", json.dumps(spd)[:500])
    run = edit(FP + "/m1/Run")
    record("edit of an untouched member: local is name+tagType only, resolved has everything inherited",
           set(run["local_obj"]) == {"name", "tagType"} and run["resolved_obj"].get("dataType") == "Boolean"
           and run["resolved_obj"].get("valueSource") == "memory", json.dumps(run)[:400])
    d = edit(UDT_PATH)
    record("edit of a UDT definition: UdtType with its parameters, no children in local",
           d["tagType"] == "UdtType" and "unit" in d["local_obj"]["parameters"] and "tags" not in d["local_obj"], json.dumps(d)[:300])
    record("edit of a folder: Folder", edit(FP)["tagType"] == "Folder")
    record("edit of a missing tag is a 404", call("GET", "/api/tags/edit?path=" + q(FP + "/nope"))["status"] == 404)
    record("edit with no path is a 400", call("GET", "/api/tags/edit")["status"] == 400)

    # ---- save
    obj = dict(a["local_obj"])
    obj["tooltip"] = "e2e tip"
    obj["documentation"] = "doc"
    s1 = save(FP + "/a1", obj, a["signature"])
    a2 = edit(FP + "/a1")
    record("save writes the edited properties and returns the new signature",
           s1["status"] == 200 and s1["json"]["ok"] and s1["json"]["signature"] == a2["signature"] != a["signature"]
           and a2["local_obj"].get("tooltip") == "e2e tip" and a2["local_obj"].get("documentation") == "doc", s1["text"])
    stale = save(FP + "/a1", {**a2["local_obj"], "tooltip": "stale write"}, a["signature"])
    record("save against a stale signature is a 409 and carries the current signature",
           stale["status"] == 409 and stale["json"].get("signature") == a2["signature"], stale["text"])
    record("...and the stale write changed nothing", edit(FP + "/a1")["local_obj"].get("tooltip") == "e2e tip")
    obj2 = {k: v for k, v in a2["local_obj"].items() if k not in ("tooltip", "documentation")}
    s2 = save(FP + "/a1", obj2, a2["signature"])
    a3 = edit(FP + "/a1")
    record("reset by removing a key really reverts: the keys are gone from local and resolved",
           s2["json"]["ok"] and "tooltip" not in a3["local_obj"] and "documentation" not in a3["local_obj"]
           and "tooltip" not in a3["resolved_obj"], json.dumps(a3["local_obj"]))
    ren = save(FP + "/a1", {**a3["local_obj"], "name": "other"}, a3["signature"])
    record("save with a changed name is a 400 (rename is its own act)", ren["status"] == 400, ren["text"])
    ty = save(FP + "/a1", {**a3["local_obj"], "tagType": "Folder"}, a3["signature"])
    record("save with a changed tagType is a 400", ty["status"] == 400, ty["text"])
    record("save of a JSON array is a 400",
           call("POST", "/api/tags/save", {"path": FP + "/a1", "json": "[1]", "signature": a3["signature"]})["status"] == 400)
    record("save with missing fields is a 400", call("POST", "/api/tags/save", {"path": FP + "/a1"})["status"] == 400)
    record("save of a missing tag is a 404", save(FP + "/nope", {"name": "nope"}, "x")["status"] == 404)
    bad = save(FP + "/a1", {**a3["local_obj"], "dataType": "NotAType"}, a3["signature"])
    record("save of an invalid configuration never 500s", bad["status"] < 500, bad["text"])

    # member override reset
    sp = edit(FP + "/m1/Speed")
    s = save(FP + "/m1/Speed", {k: v for k, v in sp["local_obj"].items() if k != "value"}, sp["signature"])
    sp2 = edit(FP + "/m1/Speed")
    record("removing a member's override reverts it to the definition's value (3.5)",
           s["json"]["ok"] and "value" not in sp2["local_obj"] and sp2["resolved_obj"]["value"] == 3.5, json.dumps(sp2)[:400])
    s = save(FP + "/m1/Speed", {**sp2["local_obj"], "value": 8.25}, sp2["signature"])
    sp3 = edit(FP + "/m1/Speed")
    record("an override can be re-added and is local", s["json"]["ok"] and sp3["local_obj"].get("value") == 8.25 and sp3["resolved_obj"]["value"] == 8.25)

    # UDT definition save keeps members; instance save keeps member overrides
    d = edit(UDT_PATH)
    dobj = json.loads(json.dumps(d["local_obj"]))
    dobj["parameters"]["site"] = {"dataType": "String", "value": "pit1"}
    s = save(UDT_PATH, dobj, d["signature"])
    d2 = edit(UDT_PATH)
    record("UDT definition save adds the parameter...", s["json"]["ok"] and "site" in d2["local_obj"]["parameters"], s["text"])
    record("...and keeps its members (and their values)",
           {"Speed", "Run"} <= set(names(UDT_PATH)) and edit(UDT_PATH + "/Speed")["local_obj"].get("value") == 3.5, names(UDT_PATH))
    record("...and the instance inherits the new parameter",
           "site" in edit(FP + "/m1")["inherited"].get("parameters", {}))
    i = edit(FP + "/m1")
    iobj = json.loads(json.dumps(i["local_obj"]))
    iobj["parameters"] = {"unit": {"dataType": "String", "value": "rpm2"}}
    s = save(FP + "/m1", iobj, i["signature"])
    i2 = edit(FP + "/m1")
    record("UDT instance save writes its parameter override...", s["json"]["ok"] and i2["local_obj"].get("parameters", {}).get("unit", {}).get("value") == "rpm2", s["text"])
    record("...and keeps its member overrides",
           {"Speed", "Run"} <= set(names(FP + "/m1")) and edit(FP + "/m1/Speed")["local_obj"].get("value") == 8.25, names(FP + "/m1"))

    # ---- model
    def model(cfg, path=FP + "/a1"):
        r = call("POST", "/api/tags/model", {"path": path, "json": json.dumps(cfg)})
        return r, {p["name"]: p for p in (r["json"] or {}).get("properties", [])}

    base = {"name": "a1", "tagType": "AtomicTag", "dataType": "Int4"}
    r, mem = model({**base, "valueSource": "memory"})
    record("model returns descriptors with name, type, default, allowedValues, category, label",
           r["status"] == 200 and all({"name", "type", "default", "allowedValues", "category", "label"} <= set(p) for p in mem.values()) and "value" in mem, r["text"][:200])
    record("model for a memory tag has no OPC properties", "opcItemPath" not in mem and "opcServer" not in mem)
    _, opc = model({**base, "valueSource": "opc"})
    record("model for an opc tag adds opcServer and opcItemPath", {"opcServer", "opcItemPath"} <= set(opc))
    _, expr = model({**base, "valueSource": "expr"})
    record("model for an expression tag adds expression and executionMode", {"expression", "executionMode"} <= set(expr))
    _, hon = model({**base, "valueSource": "memory", "historyEnabled": True})
    record("history sub-properties appear only when historyEnabled",
           "historyProvider" in hon and "sampleMode" in hon and "historyProvider" not in mem and "sampleMode" not in mem,
           sorted(set(hon) - set(mem)))
    _, lin = model({**base, "valueSource": "memory", "scaleMode": "Linear"})
    record("scaleMode other than Off adds the scaling properties", "rawLow" in lin and "rawLow" not in mem, sorted(set(lin) - set(mem)))
    record("model with bad JSON is a 400", call("POST", "/api/tags/model", {"path": FP + "/a1", "json": "{nope"})["status"] == 400)
    record("model with missing fields is a 400", call("POST", "/api/tags/model", {"path": FP + "/a1"})["status"] == 400)
    record("model for an unknown provider is a 404",
           call("POST", "/api/tags/model", {"path": "[NoSuchProvider_zz]x", "json": json.dumps(base)})["status"] == 404)

    # ---- rename
    r = call("POST", "/api/tags/rename", {"path": FP + "/a1", "newName": "a1x"})
    record("rename moves the tag to its new name", r["json"]["ok"] and "a1x" in names(FP) and "a1" not in names(FP), r["text"])
    r = call("POST", "/api/tags/rename", {"path": FP + "/dup1", "newName": "a1x"})
    record("rename onto an existing name is a 409 that says the name is taken, and changes nothing",
           r["status"] == 409 and "already exists" in r["json"]["error"] and "dup1" in names(FP), r["text"])
    r = call("POST", "/api/tags/rename", {"path": FP + "/dup1", "newName": "A1X"})
    record("the collision check ignores case, as Ignition tag names do",
           r["status"] == 409 and "dup1" in names(FP), r["text"])
    for bad in ["", "a/b", "[x]", " lead", "trail "]:
        record(f"rename to the bad name {bad!r} is a 400",
               call("POST", "/api/tags/rename", {"path": FP + "/a1x", "newName": bad})["status"] == 400)
    record("rename with missing fields is a 400", call("POST", "/api/tags/rename", {"path": FP + "/a1x"})["status"] == 400)
    record("rename of a missing tag never 500s",
           call("POST", "/api/tags/rename", {"path": FP + "/nope", "newName": "zz"})["status"] < 500)

    # ---- move / copy / duplicate
    r = call("POST", "/api/tags/move", {"paths": [FP + "/dup1"], "destination": FP, "copy": True})
    record("duplicate (copy into its own folder) increments the trailing number: dup1 -> dup2",
           r["json"]["ok"] and "dup2" in names(FP) and "dup1" in names(FP), f"{r['text']} {names(FP)}")
    call("POST", "/api/tags/move", {"paths": [FP + "/dup1"], "destination": FP, "copy": True})
    record("...and again: dup3", "dup3" in names(FP), names(FP))
    r = call("POST", "/api/tags/move", {"paths": [FP + "/dup1"], "destination": FP + "/sub", "copy": True})
    record("copy into another folder keeps the source", r["json"]["ok"] and "dup1" in names(FP + "/sub") and "dup1" in names(FP))
    r = call("POST", "/api/tags/move", {"paths": [FP + "/dup1"], "destination": FP + "/sub", "copy": False})
    record("move onto an existing name refuses (Abort) and keeps both", r["json"]["ok"] is False and "dup1" in names(FP), r["text"])
    r = call("POST", "/api/tags/move", {"paths": [FP + "/a1x"], "destination": FP + "/sub", "copy": False})
    record("move relocates the tag: gone from the source, present in the destination",
           r["json"]["ok"] and "a1x" not in names(FP) and "a1x" in names(FP + "/sub"), r["text"])
    r = call("POST", "/api/tags/move", {"paths": [FP + "/sub"], "destination": FP + "/m1", "copy": True})
    record("copying a folder into a UDT instance is refused or no-ops, never a 500", r["status"] < 500, r["text"])
    record("move with no paths is a 400", call("POST", "/api/tags/move", {"paths": [], "destination": FP})["status"] == 400)
    record("move to an unknown provider is a 404 or 400",
           call("POST", "/api/tags/move", {"paths": [FP + "/dup1"], "destination": "[NoSuchProvider_zz]"})["status"] in (400, 404))

    # ---- export / import round trip
    ex = call("GET", "/api/tags/export?path=" + q(FP + "/sub"))
    exo = json.loads((ex["json"] or {}).get("json", "{}"))
    record("export of one folder is its recursive config (not wrapped)",
           ex["status"] == 200 and exo.get("name") == "sub" and exo.get("tagType") == "Folder" and len(exo.get("tags", [])) >= 3, ex["text"][:200])
    ex2 = call("GET", "/api/tags/export?path=" + q(FP + "/sub/leaf") + "&path=" + q(FP + "/dup2"))
    exo2 = json.loads((ex2["json"] or {}).get("json", "{}"))
    record("export of several is {\"tags\":[..]}", [t["name"] for t in exo2.get("tags", [])] == ["leaf", "dup2"], ex2["text"][:200])
    record("export with no path is a 400", call("GET", "/api/tags/export")["status"] == 400)
    record("export of a missing tag is a 404", call("GET", "/api/tags/export?path=" + q(FP + "/nope"))["status"] == 404)
    create(ROOT, {"name": DEST, "tagType": "Folder"}, "Abort")
    imp = call("POST", "/api/tags/import", {"basePath": DESTP, "content": ex["json"]["json"], "format": "json", "collision": "Abort"})
    back = call("GET", "/api/tags/export?path=" + q(DESTP + "/sub"))
    record("import of an export recreates it, and re-exporting gives the same configuration (round trip)",
           imp["json"]["ok"] and norm(json.loads(back["json"]["json"])) == norm(exo), f"{imp['text']} {back['text'][:900]} vs {json.dumps(exo)[:900]}")
    imp2 = call("POST", "/api/tags/import", {"basePath": DESTP, "content": ex["json"]["json"], "format": "json", "collision": "Abort"})
    record("importing again with Abort reports ok:false", imp2["status"] == 200 and imp2["json"]["ok"] is False, imp2["text"])
    imp3 = call("POST", "/api/tags/import", {"basePath": DESTP, "content": json.dumps({"tags": [atomic("viaWrapper", "Int4", 3)]}), "format": "json"})
    record("import accepts the {\"tags\":[..]} wrapper", imp3["json"]["ok"] and "viaWrapper" in names(DESTP), imp3["text"])
    record("import with a bad format is a 400",
           call("POST", "/api/tags/import", {"basePath": DESTP, "content": "{}", "format": "csv"})["status"] == 400)
    record("import with blank content is a 400",
           call("POST", "/api/tags/import", {"basePath": DESTP, "content": " ", "format": "json"})["status"] == 400)
    record("import of broken JSON never 500s",
           call("POST", "/api/tags/import", {"basePath": DESTP, "content": "{not json", "format": "json"})["status"] < 500)
    record("import under an unknown provider is a 404",
           call("POST", "/api/tags/import", {"basePath": "[NoSuchProvider_zz]", "content": "{}", "format": "json"})["status"] == 404)

    # ---- XML export / import: the Designer's 8.x format, nested, under a base path
    xml_roundtrip()

    # ---- create / delete edge cases (the route kept from the old browser)
    r = create(FP, {"name": "x"}, "Abort")
    record("create without a tagType never 500s", r["status"] < 500, r["text"])
    record("delete with no paths is a 400", call("POST", "/api/tags/delete", {"paths": []})["status"] == 400)
    record("delete under an unknown provider is a 404", delete("[NoSuchProvider_zz]x")["status"] == 404)
    create(FP, atomic("d1"), "Overwrite")
    create(FP, atomic("d2"), "Overwrite")
    r = delete(FP + "/d1", FP + "/d2")
    record("delete removes several paths in one call", r["json"]["ok"] and not ({"d1", "d2"} & set(names(FP))), r["text"])

    # ---- security: CSRF and no session
    probes = [("/api/tags/read", {"paths": [FP + "/dup2"]}),
              ("/api/tags/write", {"path": FP + "/dup2", "value": 99}),
              ("/api/tags/create", {"basePath": FP, "json": json.dumps(atomic("csrf")), "collision": "Abort"}),
              ("/api/tags/delete", {"paths": [FP + "/dup2"]}),
              ("/api/tags/save", {"path": FP + "/dup2", "json": json.dumps({"name": "dup2", "tagType": "AtomicTag", "tooltip": "csrf"}), "signature": edit(FP + "/dup2")["signature"]}),
              ("/api/tags/model", {"path": FP + "/dup2", "json": json.dumps(base)}),
              ("/api/tags/rename", {"path": FP + "/dup2", "newName": "csrf"}),
              ("/api/tags/move", {"paths": [FP + "/dup2"], "destination": FP + "/sub", "copy": False}),
              ("/api/tags/import", {"basePath": FP, "content": json.dumps(atomic("csrf")), "format": "json"})]
    before = (names(FP), edit(FP + "/dup2")["signature"], read_values(FP + "/dup2")[0]["value"])
    for path, body in probes:
        nt = call("POST", path, body, token=False)
        bt = call("POST", path, body, token="wrong-token")
        record(f"POST {path} with no CSRF token is a 403", nt["status"] == 403, nt["text"][:100])
        record(f"POST {path} with a wrong CSRF token is a 403", bt["status"] == 403, bt["text"][:100])
    after = (names(FP), edit(FP + "/dup2")["signature"], read_values(FP + "/dup2")[0]["value"])
    record("the CSRF-refused requests changed nothing", before == after, f"{before} {after}")

    def anon(path, method="GET", body=None):
        req = urllib.request.Request(GATEWAY_URL + SPA + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"} if body is not None else {})
        try:
            urllib.request.urlopen(req, timeout=10)
            return 200
        except urllib.error.HTTPError as e:
            return e.code

    routes = [("GET", "/api/tags/providers"), ("GET", "/api/tags/browse?path=%5Bdefault%5D"),
              ("GET", "/api/tags/config?path=%5Bdefault%5D"), ("GET", "/api/tags/edit?path=%5Bdefault%5D"),
              ("GET", "/api/tags/export?path=%5Bdefault%5D"), ("POST", "/api/tags/read"),
              ("POST", "/api/tags/write"), ("POST", "/api/tags/create"), ("POST", "/api/tags/delete"),
              ("POST", "/api/tags/save"), ("POST", "/api/tags/model"), ("POST", "/api/tags/rename"),
              ("POST", "/api/tags/move"), ("POST", "/api/tags/import")]
    for method, path in routes:
        record(f"no session -> 401 on {method} {path.split('?')[0]}", anon(path, method, {} if method == "POST" else None) == 401)

    # ---- audit: every mutation kind reached ExecAudit (logged: no audit profile on this rig)
    if CONTAINER:
        log = subprocess.run(["docker", "logs", "--tail", "40000", CONTAINER], capture_output=True, text=True, timeout=60)
        text = log.stdout + log.stderr
        for kind, marker in [("tag-write", f"tag-write:{FP}/a1"), ("tag-create", "tag-create:"), ("tag-delete", "target='tag-delete'"),
                             ("tag-save", f"tag-save:{FP}/a1"), ("tag-rename", f"tag-rename:{FP}/a1"),
                             ("tag-copy", f"tag-copy:{FP}"), ("tag-move", f"tag-move:{FP}/sub"),
                             ("tag-import", f"tag-import:{DESTP}")]:
            hit = [ln for ln in text.splitlines() if marker in ln and "ExecAudit" in ln]
            record(f"a {kind} reached ExecAudit with its target and the admin user", bool(hit) and "user='admin'" in hit[-1], marker)


def xml_roundtrip():
    xsrc, xdst = PFX + "xsrc", PFX + "xdst"
    create(ROOT, {"name": xsrc, "tagType": "Folder", "tags": [
        {"name": "Sub", "tagType": "Folder", "tags": [
            atomic("m1", "Int4", 5, documentation="a <b> & c",
                   alarms=[{"name": "Hi", "mode": "AboveValue", "setpointA": 10.0, "priority": "High", "label": "lbl"}]),
            {"name": "e1", "tagType": "AtomicTag", "valueSource": "expr", "dataType": "Float8", "expression": "1+2"},
            {"name": "o1", "tagType": "AtomicTag", "valueSource": "opc", "dataType": "Int4",
             "opcServer": "Ignition OPC UA Server", "opcItemPath": "ns=1;s=[x]y"}]},
        {"name": "inst", "tagType": "UdtInstance", "typeId": UDT,
         "parameters": {"unit": {"dataType": "String", "value": "rad"}}, "tags": [{"name": "Speed", "value": 8.5}]},
    ]}, "Overwrite")
    create(ROOT, {"name": xdst, "tagType": "Folder"}, "Overwrite")
    xp = ROOT + xsrc
    ex = call("GET", "/api/tags/export?format=xml&path=" + q(xp))
    xml = (ex["json"] or {}).get("xml", "")
    record("export format=xml returns the Designer's XML (MinVersion, nested Tags, UdtInstance, alarms)",
           ex["status"] == 200 and 'MinVersion="8' in xml and 'type="UdtInstance"' in xml
           and 'name="alarms"' in xml and xml.count("<Tags>") >= 2, ex["text"][:300])
    imp = call("POST", "/api/tags/import", {"basePath": ROOT + xdst, "content": xml, "format": "xml", "collision": "Abort"})
    record("XML import under a base path succeeds", imp["status"] == 200 and imp["json"]["ok"], imp["text"])
    a = json.loads(call("GET", "/api/tags/export?path=" + q(xp))["json"]["json"])
    b = json.loads(call("GET", "/api/tags/export?path=" + q(ROOT + xdst + "/" + xsrc))["json"]["json"])
    record("XML export -> XML import into another folder: recursive configs are equal (nesting, alarms, OPC, UDT instance parameters)",
           norm(a) == norm(b), f"{json.dumps(norm(a))[:700]} vs {json.dumps(norm(b))[:700]}")

    # a UDT definition: parameter + member + alarm, round tripped through _types_
    u2 = PFX + "Motor2"
    create(TYPES, {"name": u2, "tagType": "UdtType", "parameters": {"unit": {"dataType": "String", "value": "rpm"}},
                   "tags": [atomic("Speed", "Float8", 3.5, alarms=[{"name": "Hi", "mode": "AboveValue", "setpointA": 3.0}])]}, "Overwrite")
    before = json.loads(call("GET", "/api/tags/export?path=" + q(f"{TYPES}/{u2}"))["json"]["json"])
    uxml = (call("GET", "/api/tags/export?format=xml&path=" + q(f"{TYPES}/{u2}"))["json"] or {}).get("xml", "")
    delete(f"{TYPES}/{u2}")
    r = call("POST", "/api/tags/import", {"basePath": TYPES, "content": uxml, "format": "xml", "collision": "Abort"})
    after = call("GET", "/api/tags/export?path=" + q(f"{TYPES}/{u2}"))
    record("a UDT definition (parameter, member, alarm) survives XML export then import into _types_",
           r["json"]["ok"] and after["status"] == 200 and norm(json.loads(after["json"]["json"])) == norm(before),
           f"{r['text']} {after['text'][:500]}")

    # the pre-8 flat format: path attributes count from the provider root; the base path must still apply
    legacy = ('<?xml version="1.0" encoding="UTF-8"?><Tags>'
              f'<Tag name="{PFX}L" type="Folder" path=""/>'
              f'<Tag name="Sub" type="Folder" path="{PFX}L"/>'
              f'<Tag name="mm" type="DB" path="{PFX}L/Sub"><Property name="DataType">Int4</Property>'
              '<Property name="ValueSource">memory</Property></Tag></Tags>')
    r = call("POST", "/api/tags/import", {"basePath": ROOT + xdst, "content": legacy, "format": "xml", "collision": "Overwrite"})
    record("a pre-8 flat XML import lands under the base path, nested",
           r["json"]["ok"] and exists(f"{ROOT}{xdst}/{PFX}L/Sub/mm") and not exists(f"{ROOT}{PFX}L"), r["text"])
    record("export with an unknown format is a 400",
           call("GET", "/api/tags/export?format=csv&path=" + q(xp))["status"] == 400)
    record("XML export of a missing tag is a 404",
           call("GET", "/api/tags/export?format=xml&path=" + q(xp + "/nope"))["status"] == 404)
    record("XML import of broken XML never 500s",
           call("POST", "/api/tags/import", {"basePath": ROOT + xdst, "content": "<Tags MinVersion=\"8.0.0\"><Tag", "format": "xml"})["status"] < 500)
    delete(xp, ROOT + xdst)


# ======================================================================
# P. policy
# ======================================================================

def policy_checks():
    print("P. POLICY (execution switched off)")
    if not CONTAINER:
        print("  (no container_name in config; skipped)")
        return
    make_fixture()
    exists_file = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", f"test -f {POLICY_FILE}"],
                                 capture_output=True, timeout=15).returncode == 0
    backup = subprocess.run(["docker", "exec", CONTAINER, "cat", POLICY_FILE], capture_output=True,
                            timeout=15).stdout if exists_file else None
    try:
        subprocess.run(["docker", "exec", CONTAINER, "sh", "-c",
                        f"echo 'com.gaskony.scriptide.execution.enabled=false' > {POLICY_FILE}"],
                       check=True, capture_output=True, timeout=15)
        time.sleep(3.5)  # the policy file is re-statted every 2 s
        a = edit(FP + "/a1")
        mutations = [
            ("write", "/api/tags/write", {"path": FP + "/a1", "value": 5}),
            ("create", "/api/tags/create", {"basePath": FP, "json": json.dumps(atomic("pol")), "collision": "Abort"}),
            ("delete", "/api/tags/delete", {"paths": [FP + "/a1"]}),
            ("save", "/api/tags/save", {"path": FP + "/a1", "json": a["local"], "signature": a["signature"]}),
            ("rename", "/api/tags/rename", {"path": FP + "/a1", "newName": "polx"}),
            ("move", "/api/tags/move", {"paths": [FP + "/a1"], "destination": FP + "/sub", "copy": True}),
            ("import", "/api/tags/import", {"basePath": FP, "content": json.dumps(atomic("pol")), "format": "json"}),
        ]
        codes = {n: call("POST", p, b)["status"] for n, p, b in mutations}
        record("execution.enabled=false refuses every mutation route with 403", all(c == 403 for c in codes.values()), codes)
        reads = {
            "providers": call("GET", "/api/tags/providers")["status"],
            "browse": call("GET", "/api/tags/browse?path=" + q(FP))["status"],
            "config": call("GET", "/api/tags/config?path=" + q(FP))["status"],
            "edit": call("GET", "/api/tags/edit?path=" + q(FP + "/a1"))["status"],
            "export": call("GET", "/api/tags/export?path=" + q(FP + "/a1"))["status"],
            "read": call("POST", "/api/tags/read", {"paths": [FP + "/a1"]})["status"],
            "model": call("POST", "/api/tags/model", {"path": FP + "/a1", "json": a["local"]})["status"],
        }
        record("...while every read route (incl. edit, export, model) still works", all(c == 200 for c in reads.values()), reads)
        k = set(names(FP))
        record("...and nothing was changed", "a1" in k and "pol" not in k and "polx" not in k and "a1" not in names(FP + "/sub"), k)
    finally:
        if backup is None:
            subprocess.run(["docker", "exec", CONTAINER, "rm", "-f", POLICY_FILE], capture_output=True, timeout=15)
        else:
            subprocess.run(["docker", "exec", "-i", CONTAINER, "sh", "-c", f"cat > {POLICY_FILE}"],
                           input=backup, capture_output=True, timeout=15)
        time.sleep(3.5)
    now = subprocess.run(["docker", "exec", CONTAINER, "cat", POLICY_FILE], capture_output=True, timeout=15)
    record("the policy file is restored exactly",
           (backup is None and now.returncode != 0) or (backup is not None and now.stdout == backup))
    w = call("POST", "/api/tags/write", {"path": FP + "/a1", "value": 6})
    record("...and mutations work again", w["status"] == 200 and w["json"]["ok"], w["text"])


# ======================================================================
# UI helpers
# ======================================================================

def pg():
    return C.page


def row(path):
    return pg().locator(f'.tag-tree-row[data-path="{path}"]')


def tree_open():
    return pg().locator(".tag-tree-rows").count() == 1


def open_tags_view():
    if not tree_open():
        pg().locator('.activity-item[aria-label="Tags"]').click()
        pg().wait_for_selector(".tag-tree-rows", timeout=10000)
        pg().wait_for_selector('.tag-tree-row[data-path="[default]"]', timeout=10000)


def expanded(path):
    return row(path).get_attribute("aria-expanded") == "true"


def expand(path):
    """Expand a row by clicking its chevron, every ancestor first."""
    open_tags_view()
    close = path.index("]")
    chain = [path[:close + 1]]
    for part in [p for p in path[close + 1:].split("/") if p]:
        prev = chain[-1]
        chain.append(prev + part if prev.endswith("]") else prev + "/" + part)
    for p in chain:
        row(p).wait_for(state="attached", timeout=10000)
        if row(p).get_attribute("aria-expanded") == "false":
            row(p).locator(".tag-tree-chevron").click()
            until(lambda p=p: expanded(p), 6)
    pg().wait_for_timeout(250)


def row_text(path):
    return row(path).inner_text()


def ctx(path, item, modifiers=None):
    """Right-click a row and choose a menu item; returns whether it was enabled."""
    row(path).scroll_into_view_if_needed()
    row(path).click(button="right", modifiers=modifiers)
    mi = pg().get_by_role("menuitem", name=item, exact=True)
    mi.wait_for(state="visible", timeout=5000)
    enabled = mi.is_enabled()
    if enabled:
        mi.click()
    else:
        pg().keyboard.press("Escape")
    return enabled


def menu_state(path, modifiers=None):
    row(path).click(button="right", modifiers=modifiers)
    pg().locator(".context-menu").wait_for(state="visible", timeout=5000)
    state = {}
    for mi in pg().locator(".context-menu [role=menuitem]").all():
        state[mi.inner_text().strip()] = mi.is_enabled()
    heading = pg().locator(".context-menu-heading").inner_text() if pg().locator(".context-menu-heading").count() else ""
    pg().keyboard.press("Escape")
    pg().wait_for_selector(".context-menu", state="detached", timeout=3000)
    return state, heading


def dialog():
    return pg().locator(".tag-dialog")


def fill_dialog(name=None, choice=None, submit=True):
    dialog().wait_for(state="visible", timeout=5000)
    if name is not None:
        pg().locator("#tag-dialog-input").fill(name)
    if choice is not None:
        pg().locator("#tag-dialog-choice").select_option(label=choice)
    if submit:
        dialog().locator("button[type=submit]").click()


def dialog_gone():
    return pg().locator(".tag-dialog").count() == 0


def notice():
    loc = pg().locator(".workspace-notice")
    return loc.inner_text() if loc.count() else ""


def tabs():
    return [t.inner_text().replace("•", "").strip() for t in pg().locator(".tab-strip .tab .tab-name").all()]


def active_tab():
    loc = pg().locator(".tab-strip .tab.is-active .tab-name")
    return loc.first.inner_text().strip() if loc.count() else None


def close_all_tabs():
    for _ in range(40):
        closers = pg().locator(".tab-strip .tab-close")
        if closers.count() == 0:
            break
        try:
            closers.first.click(timeout=2000)  # a tab can vanish between count() and click()
        except Exception:  # noqa: BLE001
            continue
        pg().wait_for_timeout(120)
        if pg().locator('[role=alertdialog]:has-text("before closing")').count():
            pg().get_by_role("button", name="Discard changes", exact=True).click()
            pg().wait_for_timeout(120)


def dirty_tab():
    return pg().locator(".tab-strip .tab.is-active .tab-dirty").count() == 1


def section(title):
    return pg().locator(f'section.tag-form-section[aria-label="{title}"]')


def field(label, sect):
    return section(sect).get_by_label(label, exact=True)


def open_tag(path):
    """Expand to a tag and click its row; wait for its editor."""
    parent = path.rsplit("/", 1)[0] if "/" in path[path.index("]"):] else path[:path.index("]") + 1]
    expand(parent)
    row(path).click()
    pg().wait_for_selector(f'section.tag-doc[aria-label="Tag {path}"]', timeout=10000)
    pg().wait_for_selector(".tag-form-section", timeout=10000)


def json_tab():
    pg().locator("#tag-doc-tab-json").click()
    pg().wait_for_selector("#tag-doc-panel-json .cm-content", state="visible")


def props_tab():
    pg().locator("#tag-doc-tab-properties").click()


def json_buffer():
    return pg().locator("#tag-doc-panel-json .cm-content").inner_text()


def set_json(text):
    json_tab()
    pg().locator("#tag-doc-panel-json .cm-content").click()
    pg().keyboard.press("Control+A")
    pg().keyboard.insert_text(text)
    pg().wait_for_timeout(250)


def save_ctrl_s():
    pg().keyboard.press("Control+S")


def wait_saved(path, pred, timeout=8):
    """Poll the gateway until `pred(edit-info)` holds."""
    def check():
        e = edit(path)
        return e if e and pred(e) else None
    return until(check, timeout)


def wait_tree_value(path, text, timeout=20):
    return until(lambda: text in row_text(path), timeout)


# ======================================================================
# B. tree
# ======================================================================

def tree_checks():
    print("B. TREE UI")
    page = pg()
    reads = []
    page.on("request", lambda req: reads.append(time.time()) if "/api/tags/read" in req.url else None)

    open_tags_view()
    record("the Tags activity button opens the Tags view (role=tree, rail titled Tags)",
           page.locator('.tag-tree-rows[role=tree]').count() == 1 and page.locator(".rail-title").inner_text().strip().lower() == "tags"
           and page.locator('.activity-item[aria-label="Tags"]').get_attribute("aria-pressed") == "true")
    record("the bottom panel no longer has a Tags tab", page.locator('.activity-item[aria-label="Tags"]').count() == 1)
    page.get_by_role("button", name="Refresh", exact=True).click()
    row(ROOT).click(button="right")
    mbox = page.locator(".context-menu").bounding_box()
    page.keyboard.press("Escape")
    record("the 20-item context menu fits inside the 1366x640 window (every item reachable)",
           mbox and mbox["y"] >= 0 and mbox["y"] + mbox["height"] <= 640, mbox)
    record("providers are listed at level 1 and collapsed",
           row(ROOT).count() == 1 and row(ROOT).get_attribute("aria-level") == "1" and row(ROOT).get_attribute("aria-expanded") == "false")

    # expand / collapse by click
    row(ROOT).locator(".tag-tree-chevron").click()
    record("clicking the chevron expands a provider", until(lambda: expanded(ROOT), 5) is True)
    types_row = row(f"{ROOT}_types_")
    until(lambda: types_row.count() == 1, 6)
    record("the _types_ folder is shown as 'Data Types' (and sorts first)",
           types_row.count() == 1 and types_row.locator(".tag-tree-name").inner_text() == "Data Types"
           and page.locator('.tag-tree-row[aria-level="2"]').first.get_attribute("data-path") == f"{ROOT}_types_",
           page.locator('.tag-tree-row[aria-level="2"]').first.get_attribute("data-path"))
    record("a child folder row is level 2", row(FP).get_attribute("aria-level") == "2")
    row(ROOT).locator(".tag-tree-chevron").click()
    record("clicking the chevron again collapses it and hides the children",
           until(lambda: not expanded(ROOT), 5) and row(FP).count() == 0)
    # by keyboard
    row(ROOT).click()
    page.keyboard.press("ArrowRight")
    record("ArrowRight expands the focused provider", until(lambda: expanded(ROOT), 5) is True)
    page.keyboard.press("ArrowRight")
    record("ArrowRight on an open row moves to its first child",
           until(lambda: row(f"{ROOT}_types_").get_attribute("aria-selected") == "true", 5) is True)
    page.keyboard.press("ArrowLeft")
    record("ArrowLeft on a child moves back to the parent", until(lambda: row(ROOT).get_attribute("aria-selected") == "true", 5) is True)
    page.keyboard.press("ArrowLeft")
    record("ArrowLeft on an open row collapses it", until(lambda: not expanded(ROOT), 5) is True)
    page.keyboard.press("ArrowRight")
    until(lambda: expanded(ROOT), 5)
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowDown")
    record("ArrowDown moves the selection down the rows",
           until(lambda: page.locator('.tag-tree-row[aria-selected="true"]').count() == 1
                 and page.locator('.tag-tree-row[aria-selected="true"]').get_attribute("data-path") not in (ROOT, f"{ROOT}_types_"), 20))
    page.keyboard.press("Home")
    record("Home goes to the first row", until(lambda: row(ROOT).get_attribute("aria-selected") == "true", 5) is True)

    expand(FP)
    expand(FP + "/m1")
    expand(f"{ROOT}_types_")
    record("a folder expands to its tags, an instance to its members, Data Types to the definitions",
           row(FP + "/a1").count() == 1 and row(FP + "/m1/Speed").count() == 1 and row(UDT_PATH).count() == 1)
    record("the roving tabindex: exactly one row is a tab stop",
           page.locator('.tag-tree-row[tabindex="0"]').count() == 1)

    # live values
    until(lambda: "Good" in row_text(FP + "/a1"), 20)  # the name 'a1' already has a digit, so wait for the quality
    record("an atomic tag row shows its value and quality inline", re.search(r"\b1\b", row_text(FP + "/a1")) and "Good" in row_text(FP + "/a1"), row_text(FP + "/a1"))
    call("POST", "/api/tags/write", {"path": FP + "/a1", "value": 1234})
    record("an outside write appears inline on the next poll (~5 s)", wait_tree_value(FP + "/a1", "1234"), row_text(FP + "/a1"))

    # polling stops when another view is active
    page.locator('.activity-item[aria-label="Scripting"]').click()
    page.wait_for_timeout(500)
    reads.clear()
    page.wait_for_timeout(8000)
    record("no /api/tags/read requests while another side-bar view is active", len(reads) == 0, f"{len(reads)} reads")
    page.locator('.activity-item[aria-label="Tags"]').click()
    page.wait_for_selector(".tag-tree-rows")
    got = until(lambda: len(reads) >= 1, 7)
    record("polling resumes when the Tags view is shown again", bool(got), len(reads))
    record("the tree's expansion survived switching views", row(FP + "/a1").count() == 1)
    reads.clear()
    page.wait_for_timeout(11500)
    record("while shown it reads about every 5 s", 1 <= len(reads) <= 4, f"{len(reads)} reads in 11.5 s")

    # ---- New ... kinds
    kinds = [("New Memory Tag", "n_mem", "memory"), ("New OPC Tag", "n_opc", "opc"), ("New Expression Tag", "n_expr", "expr"),
             ("New Query Tag", "n_db", "db"), ("New Reference Tag", "n_ref", "reference"), ("New Derived Tag", "n_der", "derived")]
    for item, name, source in kinds:
        ctx(FP, item)
        dialog().wait_for(state="visible")
        title = pg().locator("#tag-dialog-title").inner_text()
        fill_dialog(name)
        ok = until(lambda: exists(f"{FP}/{name}"), 8)
        e = edit(f"{FP}/{name}")
        record(f"{item} creates a {source} AtomicTag (dialog titled '{title}')",
               ok and e["tagType"] == "AtomicTag" and e["local_obj"].get("valueSource") == source, json.dumps(e and e["local_obj"]))
        until(dialog_gone, 5)
    record("each new tag shows in the tree and opens in an editor tab",
           all(row(f"{FP}/{n}").count() == 1 for _, n, _ in kinds) and {n for _, n, _ in kinds} <= set(tabs()), tabs())
    close_all_tabs()

    # dialog validation
    ctx(FP, "New Memory Tag")
    pg().locator("#tag-dialog-input").fill("bad/name")
    record("a new-tag name with / is refused as you type and Create stays disabled",
           dialog().locator(".tag-dialog-problem").count() == 1 and dialog().locator("button[type=submit]").is_disabled())
    pg().locator("#tag-dialog-input").fill("n_mem")
    dialog().locator("button[type=submit]").click()
    record("creating over an existing name shows the gateway's refusal in the dialog and creates nothing",
           until(lambda: "Refused" in (dialog().inner_text() if dialog().count() else ""), 6) is True)
    dialog().get_by_role("button", name="Cancel", exact=True).click()
    record("Cancel closes the dialog", until(dialog_gone, 4) is True)
    close_all_tabs()

    # New Folder
    ctx(FP, "New Folder")
    fill_dialog("n_folder")
    record("New Folder creates a Folder (and opens no tab)",
           until(lambda: exists(FP + "/n_folder"), 8) and edit(FP + "/n_folder")["tagType"] == "Folder" and tabs() == [], tabs())

    # New UDT Definition: only under Data Types
    st, _ = menu_state(FP)
    record("New UDT Definition is disabled outside Data Types", st.get("New UDT Definition") is False, st)
    st, _ = menu_state(f"{ROOT}_types_")
    record("New UDT Definition is enabled on Data Types", st.get("New UDT Definition") is True, st)
    ctx(f"{ROOT}_types_", "New UDT Definition")
    fill_dialog(PFX + "UiDef")
    d = until(lambda: edit(f"{TYPES}/{PFX}UiDef"), 8)
    record("New UDT Definition under Data Types creates a UdtType", d and d["tagType"] == "UdtType", d)
    close_all_tabs()

    # New UDT Instance
    ctx(FP, "New UDT Instance…")
    dialog().wait_for(state="visible")
    options = pg().locator("#tag-dialog-choice option").all_inner_texts()
    record("New UDT Instance lists the provider's UDT definitions", UDT in options and PFX + "UiDef" in options, options)
    fill_dialog("n_inst", choice=UDT)
    e = until(lambda: edit(FP + "/n_inst"), 8)
    record("New UDT Instance creates a UdtInstance of the chosen definition",
           e and e["tagType"] == "UdtInstance" and e["local_obj"].get("typeId") == UDT, e and e["local_obj"])
    close_all_tabs()

    # Rename (menu) retargets open tab
    open_tag(FP + "/n_mem")
    ctx(FP + "/n_mem", "Rename")
    record("the rename dialog is prefilled with the current name", pg().locator("#tag-dialog-input").input_value() == "n_mem")
    pg().locator("#tag-dialog-input").fill("n_mem")
    record("renaming to the same name is refused as you type", dialog().locator("button[type=submit]").is_disabled())
    fill_dialog("n_mem2")
    record("Rename (menu) renames on the gateway", until(lambda: exists(FP + "/n_mem2") and not exists(FP + "/n_mem"), 8) is True)
    record("...the tree shows the new name and the open tab followed it",
           row(FP + "/n_mem2").count() == 1 and row(FP + "/n_mem").count() == 0 and "n_mem2" in tabs() and "n_mem" not in tabs(), tabs())
    close_all_tabs()
    # Rename (F2)
    row(FP + "/n_opc").click()
    pg().keyboard.press("F2")
    dialog().wait_for(state="visible")
    pg().locator("#tag-dialog-input").fill("n_opc7")
    pg().keyboard.press("Enter")
    record("Rename (F2 then Enter) renames", until(lambda: exists(FP + "/n_opc7") and not exists(FP + "/n_opc"), 8) is True)
    close_all_tabs()

    # Duplicate
    ctx(FP + "/n_mem2", "Duplicate")
    record("Duplicate (menu) copies beside the tag, incrementing the trailing number",
           until(lambda: exists(FP + "/n_mem3"), 8) is True and exists(FP + "/n_mem2"), names(FP))
    row(FP + "/n_opc7").click()
    pg().keyboard.press("Control+d")
    record("Duplicate (Ctrl+D) copies the selected tag: n_opc7 -> n_opc8", until(lambda: exists(FP + "/n_opc8"), 8) is True, names(FP))
    close_all_tabs()

    # Copy + Paste
    ctx(FP + "/n_expr", "Copy")
    record("Copy shows the clipboard hint in the toolbar",
           until(lambda: "1 tag copied" in (page.locator(".tag-tree-hint").inner_text() if page.locator(".tag-tree-hint").count() else ""), 4) is True)
    ctx(FP + "/n_folder", "Paste")
    record("Paste into a folder puts a copy there and keeps the source",
           until(lambda: exists(FP + "/n_folder/n_expr"), 8) is True and exists(FP + "/n_expr"))
    row(FP + "/n_ref").click()
    pg().keyboard.press("Control+c")
    row(FP + "/n_folder").click()
    pg().keyboard.press("Control+v")
    record("Ctrl+C then Ctrl+V on a folder also copies", until(lambda: exists(FP + "/n_folder/n_ref"), 8) is True and exists(FP + "/n_ref"))
    # Cut + Paste
    ctx(FP + "/n_db", "Cut")
    record("Cut marks the row cut", until(lambda: row(FP + "/n_db").get_attribute("class").find("is-cut") >= 0, 4) is True)
    ctx(FP + "/n_folder", "Paste")
    record("Paste after Cut moves the tag (source gone)",
           until(lambda: exists(FP + "/n_folder/n_db") and not exists(FP + "/n_db"), 8) is True)
    record("...and the cut is used up by its paste", until(lambda: page.locator(".tag-tree-hint").count() == 0, 4) is True)

    # Write value
    ctx(FP + "/n_mem2", "Write Value…")
    pg().locator("#tag-dialog-input").fill("abc")
    record("Write Value refuses a non-number for an Int4 as you type",
           dialog().locator(".tag-dialog-problem").count() == 1 and dialog().locator("button[type=submit]").is_disabled())
    fill_dialog("55")
    v = until(lambda: (read_values(FP + "/n_mem2") or [{}])[0].get("value") == 55, 8)
    record("Write Value writes to the gateway", bool(v))
    record("...and the tree shows it", wait_tree_value(FP + "/n_mem2", "55", 9), row_text(FP + "/n_mem2"))
    st, _ = menu_state(FP)
    record("Write Value is disabled on a folder", st.get("Write Value…") is False, st)
    close_all_tabs()

    # Copy Path
    # The gateway is served over HTTP, so navigator.clipboard does not exist and
    # the app uses execCommand('copy') on a textarea: capture what that copies.
    page.evaluate("""() => { window.__copied = null; document.addEventListener('copy', () => {
        const a = document.activeElement; window.__copied = a && 'value' in a ? a.value : String(document.getSelection()); }, true); }""")
    ctx(FP + "/n_mem2", "Copy Path")
    clip = until(lambda: page.evaluate("window.__copied"), 3)
    record("Copy Path copies the full path", clip == FP + "/n_mem2", clip)

    # Export
    ctx(FP + "/n_mem2", "Export…")
    dialog().wait_for(state="visible", timeout=5000)
    record("Export asks for a format first, defaulting to JSON",
           pg().locator("#tag-dialog-choice").input_value() == "JSON"
           and pg().locator("#tag-dialog-choice option").all_inner_texts() == ["JSON", "XML"])
    with page.expect_download(timeout=10000) as dl:
        dialog().locator("button[type=submit]").click()
    path = dl.value.path()
    body = json.loads(Path(path).read_text())
    record("Export downloads <name>.json holding the tag's configuration",
           dl.value.suggested_filename == "n_mem2.json" and body.get("name") == "n_mem2" and body.get("tagType") == "AtomicTag"
           and body.get("valueSource") == "memory", f"{dl.value.suggested_filename} {body}")
    ctx(FP + "/n_folder", "Export…")
    dialog().wait_for(state="visible", timeout=5000)
    with page.expect_download(timeout=10000) as dl2:
        dialog().locator("button[type=submit]").click()
    body2 = json.loads(Path(dl2.value.path()).read_text())
    record("Export of a folder carries its children", body2.get("tagType") == "Folder" and {t["name"] for t in body2.get("tags", [])} >= {"n_expr", "n_ref", "n_db"}, body2)

    ctx(FP + "/n_folder", "Export…")
    fill_dialog(choice="XML", submit=False)
    with page.expect_download(timeout=10000) as dl3:
        dialog().locator("button[type=submit]").click()
    xml_text = Path(dl3.value.path()).read_text()
    record("Export as XML downloads <name>.xml in the Designer's format",
           dl3.value.suggested_filename == "n_folder.xml" and 'MinVersion="8' in xml_text and 'name="n_expr"' in xml_text,
           f"{dl3.value.suggested_filename} {xml_text[:200]}")

    # Import
    tmp = Path(tempfile.mkdtemp()) / "imp.json"
    tmp.write_text(json.dumps({"name": "n_imported", "tagType": "AtomicTag", "valueSource": "memory", "dataType": "Int4", "value": 11}))
    with page.expect_file_chooser(timeout=8000) as fc:
        ctx(FP + "/sub", "Import…")
    fc.value.set_files(str(tmp))
    dialog().wait_for(state="visible", timeout=8000)
    record("choosing a file opens the import dialog with the collision choice",
           "imp.json" in pg().locator("#tag-dialog-title").inner_text()
           and pg().locator("#tag-dialog-choice option").all_inner_texts() == ["Abort", "Overwrite", "Rename", "Ignore", "MergeOverwrite"])
    dialog().locator("button[type=submit]").click()
    record("Import (file chooser) creates the tag under the chosen folder", until(lambda: exists(FP + "/sub/n_imported"), 8) is True)
    with page.expect_file_chooser(timeout=8000) as fc2:
        ctx(FP + "/sub", "Import…")
    fc2.value.set_files(str(tmp))
    dialog().wait_for(state="visible", timeout=8000)
    dialog().locator("button[type=submit]").click()
    record("importing the same file again with Abort is reported as refused",
           until(lambda: "refused" in notice().lower() or "Refused" in (dialog().inner_text() if dialog().count() else ""), 8) is True, notice())
    if dialog().count():
        dialog().get_by_role("button", name="Cancel", exact=True).click()
    close_all_tabs()

    # Refresh (toolbar + menu)
    create(FP, atomic("outside1"))
    page.get_by_role("button", name="Refresh", exact=True).click()
    record("the Refresh button shows a tag created elsewhere", until(lambda: row(FP + "/outside1").count() == 1, 6) is True)
    create(FP, atomic("outside2"))
    ctx(FP, "Refresh")
    record("the Refresh menu item does too", until(lambda: row(FP + "/outside2").count() == 1, 6) is True)

    # Delete: cancel, confirm, key
    open_tag(FP + "/outside1")
    ctx(FP + "/outside1", "Delete")
    ad = page.locator('.tag-dialog[role=alertdialog]')
    record("Delete (menu) asks for confirmation and names the tag", ad.count() == 1 and "outside1" in ad.inner_text(), ad.count())
    ad.get_by_role("button", name="Cancel", exact=True).click()
    record("Cancel leaves the tag and its tab in place", exists(FP + "/outside1") and "outside1" in tabs() and until(dialog_gone, 4))
    ctx(FP + "/outside1", "Delete")
    page.locator('.tag-dialog[role=alertdialog]').get_by_role("button", name="Delete", exact=True).click()
    record("Confirming deletes it on the gateway and closes its open tab",
           until(lambda: not exists(FP + "/outside1"), 8) is True and until(lambda: "outside1" not in tabs(), 4) is True, tabs())
    row(FP + "/outside2").click()
    page.keyboard.press("Delete")
    page.locator('.tag-dialog[role=alertdialog]').wait_for(state="visible", timeout=5000)
    page.locator('.tag-dialog[role=alertdialog]').get_by_role("button", name="Delete", exact=True).click()
    record("the Delete key (then confirm) deletes the selected tag", until(lambda: not exists(FP + "/outside2"), 8) is True)
    close_all_tabs()

    # multi-select
    create(FP, atomic("ms1"))
    create(FP, atomic("ms2"))
    create(FP, atomic("ms3"))
    page.get_by_role("button", name="Refresh", exact=True).click()
    until(lambda: row(FP + "/ms3").count() == 1, 6)
    close_all_tabs()
    row(FP + "/ms1").click()
    row(FP + "/ms3").click(modifiers=["Control"])
    sel = [r.get_attribute("data-path") for r in page.locator('.tag-tree-row[aria-selected="true"]').all()]
    record("Ctrl-click adds a row to the selection (and does not move to the middle one)",
           set(sel) == {FP + "/ms1", FP + "/ms3"}, sel)
    st, heading = menu_state(FP + "/ms3", modifiers=None)
    record("the menu over a multi-selection is headed '2 tags' and Rename is disabled",
           heading == "2 tags" and st.get("Rename") is False and st.get("Write Value…") is False, f"{heading} {st}")
    row(FP + "/ms1").click()
    row(FP + "/ms3").click(modifiers=["Shift"])
    sel = [r.get_attribute("data-path") for r in page.locator('.tag-tree-row[aria-selected="true"]').all()]
    record("Shift-click selects the whole range", {FP + "/ms1", FP + "/ms2", FP + "/ms3"} <= set(sel), sel)
    ctx(FP + "/ms2", "Copy")
    record("Copy of several says how many", until(lambda: "3 tags copied" in page.locator(".tag-tree-hint").inner_text(), 4) is True)
    ctx(FP + "/sub", "Paste")
    record("Paste puts all three copies in the folder",
           until(lambda: {"ms1", "ms2", "ms3"} <= set(names(FP + "/sub")), 8) is True, names(FP + "/sub"))
    row(FP + "/ms1").click()
    row(FP + "/ms3").click(modifiers=["Shift"])
    page.keyboard.press("Delete")
    ad = page.locator('.tag-dialog[role=alertdialog]')
    ad.wait_for(state="visible", timeout=5000)
    record("Delete of a selection asks once for all of them", "Delete 3 tags?" in ad.inner_text(), ad.inner_text())
    ad.get_by_role("button", name="Delete", exact=True).click()
    record("...and removes them all", until(lambda: not any(exists(f"{FP}/{n}") for n in ("ms1", "ms2", "ms3")), 8) is True)
    record("...leaving the pasted copies alone", {"ms1", "ms2", "ms3"} <= set(names(FP + "/sub")))

    # drag and drop
    dnd_checks()

    # a provider row has no destructive items
    st, _ = menu_state(ROOT)
    record("the provider row's menu disables Rename/Duplicate/Cut/Delete but allows Copy Path/Refresh/New",
           st.get("Rename") is False and st.get("Delete") is False and st.get("Cut") is False and st.get("Duplicate") is False
           and st.get("Copy Path") is True and st.get("Refresh") is True and st.get("New Folder") is True, st)

    # menu is complete
    expected = ["New Memory Tag", "New OPC Tag", "New Expression Tag", "New Query Tag", "New Reference Tag", "New Derived Tag",
                "New Folder", "New UDT Instance…", "New UDT Definition", "Rename", "Duplicate", "Copy", "Cut", "Paste", "Delete",
                "Copy Path", "Export…", "Import…", "Write Value…", "Refresh"]
    st, _ = menu_state(FP + "/n_mem2")
    record("the context menu has every documented item", list(st) == expected, list(st))

    # disabled items with execution off (reload so the session picks the policy up)
    ui_execution_off()


def dnd_checks():
    page = pg()
    create(FP, {"name": "dnd_dest", "tagType": "Folder"}, "Abort")
    create(FP, atomic("dnd1", "Int4", 1), "Overwrite")
    create(FP, atomic("dnd2", "Int4", 2), "Overwrite")
    page.get_by_role("button", name="Refresh", exact=True).click()
    until(lambda: row(FP + "/dnd_dest").count() == 1 and row(FP + "/dnd2").count() == 1, 6)

    def drag(src, dst, ctrl=False):
        """Drag with the real mouse; returns True once something changed is the caller's job."""
        # Both rows must be on screen: the tree is a scroll container, and a row
        # scrolled out of it has a box the mouse would land on something else in.
        page.evaluate("""([a, b]) => {
          const rows = Array.from(document.querySelectorAll('.tag-tree-row'));
          const ra = rows.find((r) => r.dataset.path === a).getBoundingClientRect();
          const rb = rows.find((r) => r.dataset.path === b).getBoundingClientRect();
          const box = document.querySelector('.tag-tree-rows');
          const view = box.getBoundingClientRect();
          // centre the pair in the visible part of the tree
          box.scrollTop += ((ra.top + rb.top) / 2 + ra.height / 2) - (view.top + view.height / 2);
        }""", [src, dst])
        page.wait_for_timeout(200)
        s = row(src).bounding_box()
        d = row(dst).bounding_box()
        page.evaluate("""() => { window.__dnd = []; for (const t of ['pointerdown', 'dragstart', 'dragover', 'drop', 'dragend', 'click'])
            document.addEventListener(t, (e) => window.__dnd.push(t + ':' + (e.target.closest && e.target.closest('.tag-tree-row') ? e.target.closest('.tag-tree-row').dataset.path.split('/').pop() : e.target.tagName)), {capture: true, once: false}); }""")
        if ctrl:
            page.keyboard.down("Control")
        page.mouse.move(s["x"] + 40, s["y"] + s["height"] / 2)
        page.mouse.down()
        page.mouse.move(s["x"] + 50, s["y"] + s["height"] / 2 + 4, steps=4)
        page.mouse.move(d["x"] + 40, d["y"] + d["height"] / 2, steps=10)
        page.mouse.up()
        if ctrl:
            page.keyboard.up("Control")
        if os.environ.get("E2E_DEBUG_DND"):
            print("      dnd events:", page.evaluate("window.__dnd"), "box", s, d)

    def synthetic(src, dst, ctrl=False):
        page.evaluate("""([src, dst, ctrl]) => {
          const find = (p) => Array.from(document.querySelectorAll('.tag-tree-row')).find((e) => e.dataset.path === p);
          const dt = new DataTransfer();
          const fire = (el, type) => el.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: dt, ctrlKey: ctrl}));
          fire(find(src), 'dragstart'); fire(find(dst), 'dragenter'); fire(find(dst), 'dragover');
          fire(find(dst), 'drop'); fire(find(src), 'dragend');
        }""", [src, dst, ctrl])

    used = set()

    def dnd(src, dst, done, ctrl=False):
        """Native mouse drag (retried once), then synthetic events if it still did not land."""
        for attempt in range(2):
            page.wait_for_timeout(700)  # let an in-flight tree refresh finish: it re-renders the dragged row
            drag(src, dst, ctrl)
            if until(done, 5):
                used.add("native mouse (real HTML5 drag events)")
                return True
        synthetic(src, dst, ctrl)
        used.add("synthetic dragstart/dragover/drop with a DataTransfer")
        return bool(until(done, 5))

    moved = dnd(FP + "/dnd1", FP + "/dnd_dest", lambda: exists(FP + "/dnd_dest/dnd1") and not exists(FP + "/dnd1"))
    record("drag-and-drop onto a folder moves the tag", moved, names(FP))
    # open tab follows a drag move
    open_tag(FP + "/dnd2")
    dnd(FP + "/dnd2", FP + "/dnd_dest", lambda: exists(FP + "/dnd_dest/dnd2"))
    record("...and an open tab on the dragged tag follows it",
           until(lambda: pg().locator(f'section.tag-doc[aria-label="Tag {FP}/dnd_dest/dnd2"]').count() == 1, 6) is True,
           [e.get_attribute("aria-label") for e in pg().locator("section.tag-doc").all()])
    close_all_tabs()
    create(FP, atomic("dnd3", "Int4", 3), "Overwrite")
    page.get_by_role("button", name="Refresh", exact=True).click()
    until(lambda: row(FP + "/dnd3").count() == 1, 6)
    copied = dnd(FP + "/dnd3", FP + "/dnd_dest", lambda: exists(FP + "/dnd_dest/dnd3") and exists(FP + "/dnd3"), ctrl=True)
    record("Ctrl-drag onto a folder copies (the source stays)", copied, names(FP))
    print("      drag and drop method(s) that landed:", sorted(used))
    # a folder cannot be dropped into itself
    if row(FP + "/dnd_dest/dnd1").count():
        drag(FP + "/dnd_dest", FP + "/dnd_dest/dnd1")
        page.wait_for_timeout(800)
    record("a folder cannot be dropped into itself or its children", exists(FP + "/dnd_dest") and not exists(FP + "/dnd_dest/dnd_dest"))
    # a drop onto a non-container does nothing
    create(FP, atomic("dnd4", "Int4", 4), "Overwrite")
    page.get_by_role("button", name="Refresh", exact=True).click()
    until(lambda: row(FP + "/dnd4").count() == 1, 6)
    drag(FP + "/dnd4", FP + "/n_mem2")
    page.wait_for_timeout(800)
    record("dropping onto a plain tag does nothing", exists(FP + "/dnd4") and not exists(FP + "/n_mem2/dnd4"))


def ui_execution_off():
    if not CONTAINER:
        return
    page = pg()
    exists_file = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", f"test -f {POLICY_FILE}"],
                                 capture_output=True, timeout=15).returncode == 0
    backup = subprocess.run(["docker", "exec", CONTAINER, "cat", POLICY_FILE], capture_output=True,
                            timeout=15).stdout if exists_file else None
    try:
        subprocess.run(["docker", "exec", CONTAINER, "sh", "-c",
                        f"echo 'com.gaskony.scriptide.execution.enabled=false' > {POLICY_FILE}"],
                       check=True, capture_output=True, timeout=15)
        time.sleep(3.5)
        page.reload(wait_until="load")
        page.wait_for_selector(".activity-bar", timeout=20000)
        open_tags_view()
        expand(FP)
        st, _ = menu_state(FP + "/n_mem2")
        off = ["New Memory Tag", "New OPC Tag", "New Expression Tag", "New Query Tag", "New Reference Tag", "New Derived Tag",
               "New Folder", "New UDT Instance…", "New UDT Definition", "Rename", "Duplicate", "Cut", "Paste", "Delete", "Import…", "Write Value…"]
        on = ["Copy", "Copy Path", "Export…", "Refresh"]
        record("with execution off every changing item is disabled", all(st.get(i) is False for i in off), {i: st.get(i) for i in off})
        record("...and Copy, Copy Path, Export and Refresh stay enabled", all(st.get(i) is True for i in on), {i: st.get(i) for i in on})
        tip = pg().locator('.context-menu [role=menuitem]:has-text("Delete")').get_attribute("title") if False else None
        row(FP + "/n_mem2").click(button="right")
        title = page.get_by_role("menuitem", name="Delete", exact=True).get_attribute("title")
        page.keyboard.press("Escape")
        record("...a disabled item says why (title)", title and "Execution is switched off" in title, title)
        row(FP + "/n_mem2").click()
        page.wait_for_selector('section.tag-doc', timeout=8000)
        record("an open tag is read-only with a note and Save disabled",
               page.locator(".tag-doc-note").count() == 1 and page.locator(".tag-doc-save").is_disabled()
               and page.locator(".tag-form-section-body[disabled]").count() >= 1, page.locator(".tag-doc-note").count())
        row(FP + "/n_mem2").click()
        page.keyboard.press("F2")
        page.keyboard.press("Delete")
        page.wait_for_timeout(500)
        record("F2 and Delete do nothing while execution is off", pg().locator(".tag-dialog").count() == 0)
        close_all_tabs()
    finally:
        if backup is None:
            subprocess.run(["docker", "exec", CONTAINER, "rm", "-f", POLICY_FILE], capture_output=True, timeout=15)
        else:
            subprocess.run(["docker", "exec", "-i", CONTAINER, "sh", "-c", f"cat > {POLICY_FILE}"],
                           input=backup, capture_output=True, timeout=15)
        time.sleep(3.5)
    page.reload(wait_until="load")
    page.wait_for_selector(".activity-bar", timeout=20000)
    open_tags_view()
    expand(FP)
    st, _ = menu_state(FP + "/n_mem2")
    record("after the policy is restored and the page reloaded the menu is enabled again", st.get("Delete") is True and st.get("Rename") is True, st)


# ======================================================================
# C. editor
# ======================================================================

def editor_checks():
    print("C. EDITOR UI")
    page = pg()
    # a clean slate of tags for the editor
    delete(FP)
    create(ROOT, {"name": F, "tagType": "Folder", "tags": [
        atomic("e1", "Int4", 10),
        {"name": "eo", "tagType": "AtomicTag", "valueSource": "opc", "dataType": "Int4", "opcServer": "Ignition OPC UA Server", "opcItemPath": "ns=1;s=x"},
        {"name": "ee", "tagType": "AtomicTag", "valueSource": "expr", "dataType": "Int4", "expression": "1 + 1"},
        {"name": "m1", "tagType": "UdtInstance", "typeId": UDT, "tags": [{"name": "Speed", "value": 7.5}]},
        {"name": "sub", "tagType": "Folder"},
    ]}, "Abort")
    page.reload(wait_until="load")
    page.wait_for_selector(".activity-bar", timeout=20000)
    open_tags_view()
    expand(FP)

    # ---- which sections each kind shows
    open_tag(FP + "/e1")
    secs = [s.get_attribute("aria-label") for s in page.locator("section.tag-form-section").all()]
    record("a memory tag's Properties tab (the default) shows Basic, Value, Numeric, Metadata, Security, Scripting, Alarms and History",
           page.locator("#tag-doc-tab-properties").get_attribute("aria-selected") == "true"
           and all(s in secs for s in ["Basic", "Value", "Numeric", "Metadata", "Security", "Scripting", "Alarms", "History"]), secs)
    record("...and its header names the path and the tag type", page.locator(".tag-doc-path").inner_text() == FP + "/e1"
           and page.locator(".tag-doc-type").inner_text().strip() != "", page.locator(".tag-doc-type").inner_text())
    record("a memory tag has no OPC fields", field("OPC Item Path", "Value").count() == 0 and field("OPC Server", "Value").count() == 0)
    record("the Name field is read-only with a hint to rename from the tree",
           field("Name", "Basic").get_attribute("readonly") is not None)
    open_tag(FP + "/eo")
    record("an OPC tag shows OPC Server and OPC Item Path with their values",
           field("OPC Item Path", "Value").input_value() == "ns=1;s=x" and field("OPC Server", "Value").count() == 1,
           field("OPC Item Path", "Value").count())
    open_tag(FP + "/ee")
    record("an expression tag shows Expression (with its text) and Execution Mode",
           field("Expression", "Value").input_value() == "1 + 1" and field("Execution Mode", "Value").count() == 1,
           field("Expression", "Value").count())
    record("...and no OPC fields", field("OPC Item Path", "Value").count() == 0)
    close_all_tabs()

    # ---- edit, dirty, Ctrl+S, Save tag, Reset
    open_tag(FP + "/e1")
    record("a freshly opened tag is clean", not dirty_tab() and page.locator(".tag-doc-save").is_disabled())
    field("Value", "Value").fill("20")
    record("editing a field marks the tab and the header dirty and enables Save tag",
           dirty_tab() and page.locator(".tag-doc-dirty").count() == 1 and page.locator(".tag-doc-save").is_enabled())
    field("Value", "Value").press("Control+s")
    ok = wait_saved(FP + "/e1", lambda e: e["local_obj"].get("value") == 20)
    record("Ctrl+S saves: the gateway's local config has value 20", bool(ok), ok and ok["local_obj"])
    record("...the tab is clean again and the notice says Saved", until(lambda: not dirty_tab(), 5) is True and "Saved" in notice(), notice())
    field("Documentation", "Metadata").fill("typed by e2e")
    page.locator(".tag-doc-save").click()
    ok = wait_saved(FP + "/e1", lambda e: e["local_obj"].get("documentation") == "typed by e2e")
    record("the Save tag button saves too (Documentation)", bool(ok), ok and ok["local_obj"])
    record("an overridden field has a Reset button; the Name has none",
           page.get_by_role("button", name="Reset Documentation to inherited/default", exact=True).count() == 1
           and page.get_by_role("button", name="Reset Name to inherited/default", exact=True).count() == 0)
    page.get_by_role("button", name="Reset Documentation to inherited/default", exact=True).click()
    record("Reset removes the override from the buffer (dirty, key gone from the JSON tab)",
           dirty_tab() and "documentation" not in json.loads(json_buffer()) and field("Documentation", "Metadata").input_value() == "", json_buffer()[:200])
    props_tab()
    save_ctrl_s_in_form()
    ok = wait_saved(FP + "/e1", lambda e: "documentation" not in e["local_obj"])
    record("saving after Reset reverts it on the gateway (key gone from local AND resolved)",
           bool(ok) and "documentation" not in ok["resolved_obj"], ok and ok["local_obj"])
    # dataType select + valueSource triggers the model
    field("Value Source", "Value").select_option("opc")
    record("changing Value Source re-asks the model: OPC fields appear",
           until(lambda: field("OPC Item Path", "Value").count() == 1, 6) is True)
    page.get_by_role("button", name="Reload", exact=True).click()
    page.locator(".conflict-dialog").wait_for(state="visible", timeout=8000)
    page.get_by_role("button", name="Reload theirs (discard mine)", exact=True).click()
    record("Reload on a dirty tab raises the conflict dialog; 'Reload theirs' discards the edit",
           until(lambda: not dirty_tab() and page.locator(".conflict-dialog").count() == 0, 6) is True
           and field("Value Source", "Value").input_value() == "memory", field("Value Source", "Value").input_value())
    record("...and nothing was written", edit(FP + "/e1")["local_obj"].get("valueSource") == "memory")
    page.get_by_role("button", name="Reload", exact=True).click()
    page.wait_for_timeout(600)
    record("Reload on a clean tab re-reads silently", page.locator(".conflict-dialog").count() == 0 and not dirty_tab())

    # ---- UDT instance member: inherited dimmed, override, reset
    expand(FP + "/m1")
    row(FP + "/m1/Run").click()
    page.wait_for_selector(f'section.tag-doc[aria-label="Tag {FP}/m1/Run"]')
    page.wait_for_selector(".tag-form-section")
    rowv = section("Value").locator(".tag-form-row", has=page.locator("label", has_text=re.compile(r"^Value$")))
    record("an untouched UDT member shows its inherited Value dimmed (italic, muted) with no Reset",
           "is-inherited" in rowv.get_attribute("class") and rowv.locator("input").evaluate("e => getComputedStyle(e).fontStyle") == "italic"
           and page.get_by_role("button", name="Reset Value to inherited/default", exact=True).count() == 0)
    record("...Data Type and Value Source show the definition's values",
           field("Data Type", "Value").input_value() == "Boolean" and field("Value Source", "Value").input_value() == "memory")
    page.screenshot(path=str(SHOTS / "03-udt-member-inherited.png"))
    field("Value", "Value").check()
    ok = wait_saved(FP + "/m1/Run", lambda e: False, 0.1)
    page.keyboard.press("Control+s")
    ok = wait_saved(FP + "/m1/Run", lambda e: e["local_obj"].get("value") is True)
    record("overriding a member and saving makes it local on the gateway", bool(ok), ok and ok["local_obj"])
    record("...the row is no longer dimmed and now has a Reset button",
           "is-overridden" in section("Value").locator(".tag-form-row").filter(has=page.locator("label", has_text=re.compile(r"^Value$"))).get_attribute("class")
           and page.get_by_role("button", name="Reset Value to inherited/default", exact=True).count() == 1)
    page.get_by_role("button", name="Reset Value to inherited/default", exact=True).click()
    page.keyboard.press("Control+s") if False else None
    page.locator(".tag-doc-save").click()
    ok = wait_saved(FP + "/m1/Run", lambda e: "value" not in e["local_obj"])
    record("Reset + save puts the member back to inherited on the gateway (value false again)",
           bool(ok) and ok["resolved_obj"].get("value") is False, ok and ok["resolved_obj"])
    row(FP + "/m1/Speed").click()
    page.wait_for_selector(f'section.tag-doc[aria-label="Tag {FP}/m1/Speed"]')
    page.wait_for_selector(".tag-form-section")
    record("an overridden member shows its override (7.5) normally, with Reset",
           field("Value", "Value").input_value() == "7.5" and page.get_by_role("button", name="Reset Value to inherited/default", exact=True).count() == 1)
    page.get_by_role("button", name="Reset Value to inherited/default", exact=True).click()
    record("after Reset the form shows the definition's 3.5 dimmed", field("Value", "Value").input_value() == "3.5")
    page.locator(".tag-doc-save").click()
    ok = wait_saved(FP + "/m1/Speed", lambda e: "value" not in e["local_obj"])
    record("...and saving makes the gateway agree", bool(ok) and ok["resolved_obj"]["value"] == 3.5, ok and ok["resolved_obj"])
    close_all_tabs()

    # ---- alarms
    open_tag(FP + "/e1")
    section("Alarms").scroll_into_view_if_needed()
    record("a tag with no alarms says so", "No alarms" in section("Alarms").inner_text())
    section("Alarms").get_by_role("button", name="Add alarm", exact=True).click()
    record("Add alarm adds one and selects it", section("Alarms").locator(".tag-form-alarm-item").count() == 1 and dirty_tab())
    ag = section("Alarms").locator(".tag-form-alarm-edit")
    ag.get_by_label("Name", exact=True).fill("HighTemp")
    ag.get_by_label("Mode", exact=True).select_option("AboveValue")
    ag.get_by_label("Setpoint", exact=True).fill("50")
    ag.get_by_label("Priority", exact=True).select_option("High")
    page.screenshot(path=str(SHOTS / "04-alarms.png"))
    page.keyboard.press("Control+s")
    ok = wait_saved(FP + "/e1", lambda e: any(a.get("name") == "HighTemp" for a in e["local_obj"].get("alarms", [])))
    al = (ok or {"local_obj": {}})["local_obj"].get("alarms", [{}])[0]
    record("saving an alarm: the gateway holds name, mode, setpoint and priority",
           bool(ok) and al.get("mode") == "AboveValue" and al.get("setpointA") == 50 and al.get("priority") == "High", al)
    ag.get_by_label("Setpoint", exact=True).fill("60")
    ag.get_by_label("Priority", exact=True).select_option("Critical")
    ag.get_by_label("Mode", exact=True).select_option("BetweenValues")
    record("a mode that needs a second setpoint shows High Setpoint", ag.get_by_label("High Setpoint", exact=True).count() == 1)
    ag.get_by_label("High Setpoint", exact=True).fill("90")
    page.locator(".tag-doc-save").click()
    ok = wait_saved(FP + "/e1", lambda e: e["local_obj"].get("alarms", [{}])[0].get("priority") == "Critical")
    al = (ok or {"local_obj": {}})["local_obj"].get("alarms", [{}])[0]
    record("editing an alarm saves the changes", bool(ok) and al.get("setpointA") == 60 and al.get("setpointB") == 90 and al.get("mode") == "BetweenValues", al)
    section("Alarms").get_by_role("button", name="Duplicate", exact=True).click()
    record("Duplicate makes a copy with a free name", section("Alarms").locator(".tag-form-alarm-item").count() == 2)
    section("Alarms").get_by_role("button", name="Delete", exact=True).click()
    section("Alarms").get_by_role("button", name="Delete", exact=True).click()
    record("Delete removes the selected alarm (twice -> none left)", section("Alarms").locator(".tag-form-alarm-item").count() == 0)
    page.locator(".tag-doc-save").click()
    ok = wait_saved(FP + "/e1", lambda e: not e["local_obj"].get("alarms"))
    record("saving with all alarms deleted leaves none on the gateway", bool(ok), ok and ok["local_obj"].get("alarms"))

    # ---- history
    section("History").scroll_into_view_if_needed()
    record("History sub-properties are hidden until History Enabled is on", field("Storage Provider", "History").count() == 0)
    field("History Enabled", "History").check()
    record("enabling history re-asks the model: Storage Provider and Sample Mode appear",
           until(lambda: field("Storage Provider", "History").count() == 1 and field("Sample Mode", "History").count() == 1, 6) is True)
    prov_opts = field("Storage Provider", "History").locator("option").all_inner_texts()
    mode_opts = field("Sample Mode", "History").locator("option").all_inner_texts()
    prov = next((o for o in prov_opts if o), None)
    mode = mode_opts[-1] if mode_opts else None
    if prov:
        field("Storage Provider", "History").select_option(label=prov)
    if mode:
        field("Sample Mode", "History").select_option(label=mode)
    page.locator(".tag-doc-save").click()
    ok = wait_saved(FP + "/e1", lambda e: e["local_obj"].get("historyEnabled") is True)
    record("saving history: historyEnabled true with the chosen provider and sample mode on the gateway",
           bool(ok) and (not prov or ok["local_obj"].get("historyProvider") == prov) and (not mode or ok["local_obj"].get("sampleMode") == mode),
           f"{ok and ok['local_obj']} prov={prov} mode={mode}")
    print(f"      history provider options: {prov_opts}; sample modes: {mode_opts}")

    # ---- event script
    section("Scripting").scroll_into_view_if_needed()
    section("Scripting").get_by_label("Add event script", exact=True).select_option(label="Value Changed")
    cm = section("Scripting").locator(".tag-form-code .cm-content")
    cm.wait_for(state="visible", timeout=5000)
    cm.click()
    page.keyboard.press("Control+A")
    page.keyboard.insert_text("\tsystem.util.getLogger('e2e').info('changed')")
    record("an event script gets a CodeMirror editor with its def signature shown",
           "valueChanged(tag, tagPath" in section("Scripting").locator(".tag-form-script-sig").inner_text() and dirty_tab())
    page.locator(".tag-doc-save").click()
    ok = wait_saved(FP + "/e1", lambda e: any(s.get("eventid") == "valueChanged" for s in e["local_obj"].get("eventScripts", [])))
    sc = next((s for s in (ok or {"local_obj": {}})["local_obj"].get("eventScripts", []) if s.get("eventid") == "valueChanged"), {})
    record("saving a valueChanged script: the gateway holds its body, tab-indented",
           bool(ok) and sc.get("script", "").startswith("\t") and "getLogger('e2e')" in sc.get("script", ""), sc)
    section("Scripting").get_by_role("button", name="Remove Value Changed script", exact=True).click()
    page.locator(".tag-doc-save").click()
    ok = wait_saved(FP + "/e1", lambda e: not e["local_obj"].get("eventScripts"))
    record("removing the script and saving drops it", bool(ok), ok and ok["local_obj"].get("eventScripts"))
    close_all_tabs()

    # ---- UDT definition parameters
    expand(TYPES)
    open_tag(UDT_PATH)
    secs = [s.get_attribute("aria-label") for s in page.locator("section.tag-form-section").all()]
    record("a UDT definition shows a Parameters section with its existing parameter",
           "Parameters" in secs and section("Parameters").get_by_role("cell", name="unit").count() >= 0 and "unit" in section("Parameters").inner_text(), secs)
    section("Parameters").get_by_label("New parameter", exact=True).fill("e2eparam")
    section("Parameters").get_by_role("button", name="Add parameter", exact=True).click()
    section("Parameters").get_by_label("e2eparam value", exact=True).fill("42")
    section("Parameters").get_by_label("e2eparam data type", exact=True).select_option("Integer")
    page.locator(".tag-doc-save").click()
    ok = wait_saved(UDT_PATH, lambda e: "e2eparam" in e["local_obj"].get("parameters", {}))
    pr = (ok or {"local_obj": {"parameters": {}}})["local_obj"]["parameters"].get("e2eparam", {})
    record("adding a parameter and saving: name, type and value are on the gateway", bool(ok) and pr.get("dataType") == "Integer" and str(pr.get("value")) == "42", pr)
    record("...and the definition's members survived the save", {"Speed", "Run"} <= set(names(UDT_PATH)), names(UDT_PATH))
    section("Parameters").get_by_role("button", name="Remove parameter e2eparam", exact=True).click()
    page.locator(".tag-doc-save").click()
    ok = wait_saved(UDT_PATH, lambda e: "e2eparam" not in e["local_obj"].get("parameters", {}))
    record("removing the parameter and saving drops it", bool(ok))
    close_all_tabs()

    # ---- JSON tab
    open_tag(FP + "/e1")
    json_tab()
    record("the JSON tab shows the tag's own configuration as JSON",
           json.loads(json_buffer()).get("valueSource") == "memory" and not dirty_tab())
    page.screenshot(path=str(SHOTS / "05-json-tab.png"))
    cur = json.loads(json_buffer())
    cur["documentation"] = "from the JSON tab"
    set_json(json.dumps(cur, indent=2))
    props_tab()
    record("an edit on the JSON tab marks it dirty and the Properties tab reflects it",
           dirty_tab() and field("Documentation", "Metadata").input_value() == "from the JSON tab")
    json_tab()
    set_json('{"name": "e1", "tagType": "AtomicTag", "valueSource": ')
    err = page.locator(".tag-doc-error")
    record("invalid JSON shows an alert and disables Save tag",
           err.count() == 1 and "does not parse" in err.inner_text() and page.locator(".tag-doc-save").is_disabled(), err.count())
    page.keyboard.press("Control+s")
    page.wait_for_timeout(800)
    record("Ctrl+S with invalid JSON writes nothing", edit(FP + "/e1")["local_obj"].get("documentation") is None)
    props_tab()
    record("the Properties tab explains it cannot show unparseable JSON", "does not parse" in page.locator(".tag-form-message").inner_text())
    set_json(json.dumps(cur, indent=2))
    record("fixing the JSON clears the alert and re-enables Save", page.locator(".tag-doc-error").count() == 0 and page.locator(".tag-doc-save").is_enabled())
    page.locator(".tag-doc-save").click()
    ok = wait_saved(FP + "/e1", lambda e: e["local_obj"].get("documentation") == "from the JSON tab")
    record("saving from the JSON tab writes it", bool(ok))
    # cleanup doc override
    obj = dict(ok["local_obj"]) if ok else {}
    obj.pop("documentation", None)
    if ok:
        save(FP + "/e1", obj, ok["signature"])
    page.get_by_role("button", name="Reload", exact=True).click()
    page.wait_for_timeout(700)

    # ---- closing a dirty tab
    props_tab()
    field("Tooltip", "Metadata").fill("unsaved")
    page.locator(".tab-strip .tab.is-active .tab-close").click()
    pc = page.locator('[role=alertdialog]:has-text("before closing")')
    record("closing a dirty tab asks to save first", pc.count() == 1 and "Save e1 before closing?" in pc.inner_text(), pc.count())
    pc.get_by_role("button", name="Cancel", exact=True).click()
    record("Cancel keeps the tab and its edit", "e1" in tabs() and dirty_tab())
    page.locator(".tab-strip .tab.is-active .tab-close").click()
    page.get_by_role("button", name="Discard changes", exact=True).click()
    record("Discard changes closes the tab without writing", "e1" not in tabs() and edit(FP + "/e1")["local_obj"].get("tooltip") is None)
    open_tag(FP + "/e1")
    field("Tooltip", "Metadata").fill("saved on close")
    page.locator(".tab-strip .tab.is-active .tab-close").click()
    page.locator('[role=alertdialog]:has-text("before closing")').get_by_role("button", name="Save and close", exact=True).click()
    record("Save and close in the close prompt writes the tag",
           bool(wait_saved(FP + "/e1", lambda e: e["local_obj"].get("tooltip") == "saved on close")))
    record("...and then closes the tab", until(lambda: "e1" not in tabs(), 6) is True, tabs())
    close_all_tabs()

    # ---- conflict
    open_tag(FP + "/e1")
    e = edit(FP + "/e1")
    save(FP + "/e1", {**e["local_obj"], "tooltip": "changed by someone else"}, e["signature"])
    field("Documentation", "Metadata").fill("mine")
    field("Documentation", "Metadata").press("Control+s")
    cd = page.locator(".conflict-dialog")
    cd.wait_for(state="visible", timeout=8000)
    record("saving a tag changed on the gateway since it was opened raises the conflict dialog with a diff",
           "changed on the gateway" in cd.inner_text() and cd.locator(".conflict-row").count() > 1, cd.inner_text()[:150])
    record("the conflict dialog calls it a tag, not a script",
           "This tag was written" in cd.inner_text() and "This script" not in cd.inner_text(), cd.inner_text()[:200])
    record("...and nothing of mine was written yet", edit(FP + "/e1")["local_obj"].get("documentation") is None)
    cd.get_by_role("button", name="Cancel", exact=True).click()
    record("Cancel keeps my edit pending", dirty_tab() and until(lambda: page.locator(".conflict-dialog").count() == 0, 4) is True)
    field("Documentation", "Metadata").press("Control+s")
    page.locator(".conflict-dialog").wait_for(state="visible", timeout=8000)
    page.get_by_role("button", name="Keep mine (overwrite theirs)", exact=True).click()
    ok = wait_saved(FP + "/e1", lambda e: e["local_obj"].get("documentation") == "mine")
    record("'Keep mine' overwrites: the gateway now holds my Documentation", bool(ok), ok and ok["local_obj"])
    record("...then the tab is clean", until(lambda: not dirty_tab(), 5) is True)
    # Reload theirs path
    e = edit(FP + "/e1")
    save(FP + "/e1", {**e["local_obj"], "tooltip": "theirs again"}, e["signature"])
    field("Documentation", "Metadata").fill("mine 2")
    field("Documentation", "Metadata").press("Control+s")
    page.locator(".conflict-dialog").wait_for(state="visible", timeout=8000)
    page.get_by_role("button", name="Reload theirs (discard mine)", exact=True).click()
    record("'Reload theirs' discards mine and shows the gateway's copy",
           until(lambda: field("Tooltip", "Metadata").count() == 1 and field("Tooltip", "Metadata").input_value() == "theirs again", 6) is True
           and field("Documentation", "Metadata").input_value() == "mine" and not dirty_tab())
    close_all_tabs()

    # ---- retarget on rename/move, close on delete
    create(FP, atomic("rt1", "Int4", 1), "Overwrite")
    create(FP, atomic("rt2", "Int4", 2), "Overwrite")
    page.get_by_role("button", name="Refresh", exact=True).click()
    until(lambda: row(FP + "/rt2").count() == 1, 6)
    open_tag(FP + "/rt1")
    ctx(FP + "/rt1", "Rename")
    fill_dialog("rt1b")
    record("renaming a tag in the tree retargets its open (clean) tab: label, header path and content",
           until(lambda: pg().locator(f'section.tag-doc[aria-label="Tag {FP}/rt1b"]').count() == 1, 8) is True
           and "rt1b" in tabs() and page.locator(".tag-doc-path").inner_text() == FP + "/rt1b"
           and field("Name", "Basic").input_value() == "rt1b", tabs())
    field("Tooltip", "Metadata").fill("dirty over rename")
    ctx(FP + "/rt1b", "Rename")
    fill_dialog("rt1c")
    until(lambda: exists(FP + "/rt1c"), 8)
    record("renaming under a dirty tab keeps the unsaved edit and brings its name along",
           until(lambda: pg().locator(f'section.tag-doc[aria-label="Tag {FP}/rt1c"]').count() == 1, 8) is True and dirty_tab()
           and json.loads(json_buffer()).get("name") == "rt1c" if (json_tab() or True) else False, json_buffer()[:150])
    props_tab()
    page.locator(".tag-doc-save").click()
    page.locator(".conflict-dialog").wait_for(state="visible", timeout=8000)
    record("the first save after a rename under unsaved edits goes through the conflict dialog (by design: the signature covers the name)",
           "rt1c" in page.locator(".conflict-dialog h2").inner_text())
    page.get_by_role("button", name="Keep mine (overwrite theirs)", exact=True).click()
    ok = wait_saved(FP + "/rt1c", lambda e: e["local_obj"].get("tooltip") == "dirty over rename")
    record("...and 'Keep mine' then saves it to the renamed tag", bool(ok), ok and ok["local_obj"])
    # move
    ctx(FP + "/rt1c", "Cut")
    ctx(FP + "/sub", "Paste")
    until(lambda: exists(FP + "/sub/rt1c"), 8)
    record("moving the tag (Cut/Paste) retargets the open tab to the new path",
           until(lambda: pg().locator(f'section.tag-doc[aria-label="Tag {FP}/sub/rt1c"]').count() == 1, 8) is True and not exists(FP + "/rt1c"), tabs())
    # delete
    ctx(FP + "/sub", "Delete")
    page.locator('.tag-dialog[role=alertdialog]').get_by_role("button", name="Delete", exact=True).click()
    record("deleting the folder holding an open tag closes that tab",
           until(lambda: "rt1c" not in tabs(), 20) is True and not exists(FP + "/sub"), tabs())
    close_all_tabs()


def save_ctrl_s_in_form():
    pg().locator(".tag-doc").focus() if False else None
    pg().locator(".tag-form-label").first.click()
    pg().keyboard.press("Control+s")


# ======================================================================
# D. layout
# ======================================================================

def audit(label):
    r = pg().evaluate(JS_SCROLL_AUDIT)
    stray = [i for i in r["items"] if not any(w in i["el"] for w in SCROLL_WHITELIST)]
    page_ok = r["page"]["y"] <= 0 and r["page"]["x"] <= 0 and r["page"]["by"] <= 0
    record(f"{label}: no page scroll", page_ok, r["page"])
    record(f"{label}: no scroll bar except the intended surfaces", not stray, stray)
    allowed = [i["el"] for i in r["items"] if any(w in i["el"] for w in SCROLL_WHITELIST)]
    if allowed:
        print(f"      whitelisted scroll surfaces present: {allowed}")


def scrolled_refresh_check(tag):
    """Scrolled mid-way, the tree's toolbar is a solid header that no row reaches into."""
    page = pg()
    page.evaluate("() => { const r = document.querySelector('.tag-tree-rows'); r.scrollTop = Math.min(r.scrollHeight - r.clientHeight, 213); }")
    page.wait_for_timeout(250)
    g = page.evaluate("""() => {
      const tb = document.querySelector('.tag-tree-toolbar'), rows = document.querySelector('.tag-tree-rows');
      const t = tb.getBoundingClientRect(), r = rows.getBoundingClientRect();
      const probe = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && tb.contains(e); };
      return {scrolled: rows.scrollTop, tbBottom: t.bottom, rowsTop: r.top, bg: getComputedStyle(tb).backgroundColor,
              hits: [t.left + 4, t.left + t.width / 2, t.right - 4].map((x) => probe(x, t.top + t.height / 2)).concat(
                    [t.left + t.width / 2].map((x) => probe(x, t.bottom - 2)))};
    }""")
    record(f"{tag} scrolled tree: toolbar sits above the rows, has a solid background, and nothing shows through it",
           (g["scrolled"] > 0 or not tag.startswith("1366")) and g["tbBottom"] <= g["rowsTop"] + 0.5 and g["bg"] not in ("rgba(0, 0, 0, 0)", "transparent") and all(g["hits"]), g)
    page.evaluate("() => { document.querySelector('.tag-tree-rows').scrollTop = 0; }")


def layout_checks():
    print("D. LAYOUT")
    page = pg()
    delete(FP)
    create(ROOT, {"name": F, "tagType": "Folder", "tags": [
        atomic("e1", "Int4", 10, documentation="x" * 400),
        {"name": "m1", "tagType": "UdtInstance", "typeId": UDT, "tags": [{"name": "Speed", "value": 7.5}]},
    ] + [atomic(f"filler{n:02d}", "Int4", n) for n in range(40)]}, "Abort")
    call("POST", "/api/tags/save", {"path": FP + "/e1", "json": json.dumps({
        **edit(FP + "/e1")["local_obj"],
        "alarms": [{"name": "HighTemp", "mode": "AboveValue", "setpointA": 50, "priority": "High"}]}),
        "signature": edit(FP + "/e1")["signature"]})
    page.reload(wait_until="load")
    page.wait_for_selector(".activity-bar", timeout=20000)

    for (w, h) in [(1366, 640), (1920, 1080)]:
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(400)
        tag = f"{w}x{h}"
        open_tags_view()
        expand(FP)
        expand(FP + "/m1")
        close_all_tabs()
        page.wait_for_timeout(300)
        audit(f"{tag} tree with no tab open")
        scrolled_refresh_check(tag)
        open_tag(FP + "/e1")
        page.wait_for_timeout(300)
        audit(f"{tag} tree + memory tag (Properties)")
        if (w, h) == (1366, 640):
            page.screenshot(path=str(SHOTS / "01-tree-and-memory-tag.png"))
        # a second tab so the tab strip has two tabs to lay out
        row(FP + "/m1/Speed").click()
        page.wait_for_selector(f'section.tag-doc[aria-label="Tag {FP}/m1/Speed"]')
        page.wait_for_selector(".tag-form-section")
        page.wait_for_timeout(300)
        audit(f"{tag} UDT member with inherited values")
        if (w, h) == (1366, 640):
            page.screenshot(path=str(SHOTS / "02-udt-member-form.png"))
        strip = page.evaluate("""() => { const s = document.querySelector('.tab-strip'); const c = getComputedStyle(s);
            return {oy: c.overflowY, ox: c.overflowX, bar: s.offsetWidth - s.clientWidth, sh: s.scrollHeight, ch: s.clientHeight}; }""")
        record(f"{tag} the tab strip has overflow-y hidden, reserves no scroll bar and its content fits vertically",
               strip["oy"] == "hidden" and strip["bar"] == 0 and strip["sh"] <= strip["ch"] + 1, strip)
        open_tag(FP + "/e1")
        section("Alarms").scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        audit(f"{tag} alarms section")
        if (w, h) == (1366, 640):
            record("the alarm editor is shown with its alarm selected", section("Alarms").locator(".tag-form-alarm-item").count() == 1)
        json_tab()
        page.wait_for_timeout(300)
        audit(f"{tag} JSON tab")
        props_tab()
        close_all_tabs()

    # Prove the check catches the tab-strip bug and that the shipped CSS fixes it.
    # The original bug is a sub-pixel overflow (a tab a pixel taller than the
    # strip under its bottom rule), which depends on fractional line heights; so
    # force exactly that 1px here, then compare the shipped CSS with the old one.
    page.set_viewport_size({"width": 1366, "height": 640})
    open_tag(FP + "/e1")
    page.wait_for_timeout(300)
    page.evaluate("""() => { const s = document.querySelector('.tab-strip'); s.style.height = s.clientHeight + 'px';
        for (const t of s.querySelectorAll('.tab')) t.style.height = (s.clientHeight + 1) + 'px'; }""")
    strip_hits = lambda: [i for i in page.evaluate(JS_SCROLL_AUDIT)["items"]  # noqa: E731
                          if i["el"].startswith("div.tab-strip") and "tab-strip-row" not in i["el"]]
    record("self-test A: with a tab forced 1px taller than the strip, the shipped CSS (overflow-y: hidden) shows no scroll bar there",
           not strip_hits(), strip_hits())
    page.evaluate("document.querySelector('.tab-strip').style.overflowY = 'auto'")
    hits = strip_hits()
    record("self-test B: ...and with the pre-fix CSS (overflow-y: auto) the same audit flags a vertical scroll bar on the strip",
           bool(hits) and any(i["overY"] or i["barY"] for i in hits), hits)
    page.evaluate("""() => { const s = document.querySelector('.tab-strip'); s.style.height = ''; s.style.overflowY = '';
        for (const t of s.querySelectorAll('.tab')) t.style.height = ''; }""")
    close_all_tabs()


def screenshot_checks():
    """Only the screenshots of sections that ran: D writes 01-02, C writes 03-05."""
    expected = (["01-tree-and-memory-tag.png", "02-udt-member-form.png"] if want("D") else []) \
        + (["03-udt-member-inherited.png", "04-alarms.png", "05-json-tab.png"] if want("C") else [])
    if not expected:
        return
    missing = [n for n in expected if not (SHOTS / n).exists() or (SHOTS / n).stat().st_mtime < RUN_START - 1]
    record(f"the {len(expected)} screenshots of the sections that ran were written this run", not missing, missing)


# ======================================================================
# E. Console and Query as editor-area tabs
# ======================================================================

def activity_btn(label):
    return pg().locator(f'.activity-item[aria-label="{label}"]')


def pane(n):
    return pg().locator(".workspace-pane").nth(n)


def pressed(label):
    return activity_btn(label).get_attribute("aria-pressed")


def outline_count():
    return pg().locator("aside.outline").count()


def secondary_toggle():
    return pg().locator('button[aria-label^="Toggle secondary side bar"]')


def tool_geometry():
    """The tool body against its pane: it should fill what is left under the strip."""
    return pg().evaluate("""() => {
      const b = document.querySelector('.tool-tab-body'); if (!b) return null;
      const pane = b.closest('.workspace-pane'), strip = pane.querySelector('.tab-strip-row');
      const r = b.getBoundingClientRect(), p = pane.getBoundingClientRect(), s = strip.getBoundingClientRect();
      return {top: r.top, bottom: r.bottom, h: r.height, w: r.width, paneBottom: p.bottom, paneH: p.height,
              stripBottom: s.bottom, gapTop: r.top - s.bottom, gapBottom: p.bottom - r.bottom,
              vh: window.innerHeight};
    }""")


def tool_tab_checks():
    print("E. CONSOLE + QUERY TABS")
    page = pg()
    delete(FP)
    create(ROOT, {"name": F, "tagType": "Folder", "tags": [atomic("a1", "Int4", 1)]}, "Abort")
    page.set_viewport_size({"width": 1366, "height": 640})
    page.reload(wait_until="load")
    page.wait_for_selector(".activity-bar", timeout=20000)
    close_all_tabs()
    panel_was_open = page.locator("section.panel").count() == 1

    # ---- they open as editor tabs, not in the bottom panel
    activity_btn("Script Console").click()
    page.wait_for_selector(".console-editor .cm-content", timeout=15000)
    record("Script Console opens as an editor-area tab (not in the bottom panel)",
           tabs() == ["Script Console"] and page.locator("section.panel .console").count() == 0
           and page.locator(".workspace-pane .console").count() == 1, tabs())
    activity_btn("Query").click()
    page.wait_for_selector(".qb-editor .cm-content", timeout=15000)
    record("Query opens as a second editor-area tab beside the console tab",
           tabs() == ["Script Console", "Query"] and page.locator("section.panel .qb").count() == 0, tabs())

    # ---- full editor height at 1366x640
    g = tool_geometry()
    print("      query tab geometry:", g)
    record("Query's body fills the pane under the tab strip at 1366x640 (flush top and bottom, over 300px tall)",
           g and g["gapTop"] <= 3 and g["gapBottom"] <= 3 and g["h"] > 300, g)
    activity_btn("Script Console").click()
    page.wait_for_selector(".console-editor .cm-content", timeout=10000)
    g = tool_geometry()
    record("Script Console's body fills the pane under the tab strip at 1366x640",
           g and g["gapTop"] <= 3 and g["gapBottom"] <= 3 and g["h"] > 300, g)
    r = page.evaluate("""() => { const c = document.querySelector('.console'), b = document.querySelector('.tool-tab-body');
        const r = c.getBoundingClientRect(), p = b.getBoundingClientRect();
        return {ch: r.height, bh: p.height}; }""")
    record("...and the console component itself fills that body", abs(r["ch"] - r["bh"]) <= 2, r)

    # ---- the bottom panel still offers Problems / Terminal / Tests, and only those
    if not panel_was_open:
        page.locator('button[aria-label="Toggle panel"]').click()
    page.wait_for_selector("section.panel .panel-tab", timeout=5000)
    ptabs = [t.inner_text().strip().lower() for t in page.locator("section.panel .panel-tab").all()]
    record("the bottom panel offers Problems, Terminal and Tests and no Console, Query or Tags",
           all(any(n in t for t in ptabs) for n in ("problems", "terminal", "tests"))
           and not any(w in t for t in ptabs for w in ("console", "query", "tags")), ptabs)
    if not panel_was_open:
        page.locator('button[aria-label="Toggle panel"]').click()
        page.wait_for_selector("section.panel", state="detached", timeout=5000)

    # ---- running print 1+1 gives 2
    page.locator(".console-editor .cm-content").click()
    page.keyboard.press("Control+A")
    page.keyboard.insert_text("print 1+1")
    page.locator(".console-toolbar button.primary").click()
    got = until(lambda: any(ln.strip() == "2" for ln in page.locator(".console-output").inner_text().splitlines()), 30)
    record("running `print 1+1` in the console tab prints 2", bool(got), page.locator(".console-output").inner_text()[:300])

    # ---- state survives a trip to another tab
    page.locator(".console-run, .console-block").first.wait_for(state="attached", timeout=5000)
    out_before = page.locator(".console-output").inner_text()
    activity_btn("Query").click()
    page.wait_for_selector(".qb-editor .cm-content", timeout=10000)
    page.locator(".qb-editor .cm-content").click()
    page.keyboard.press("Control+A")
    page.keyboard.insert_text("select 1 as zz_e2e_marker")
    record("the console is hidden (not in the DOM) while the Query tab is active",
           page.locator(".console").count() == 0)
    record("aria-pressed on the activity button follows the active tab (Query pressed, Console not)",
           pressed("Query") == "true" and pressed("Script Console") == "false", (pressed("Query"), pressed("Script Console")))

    # a tag tab, then a script tab, in between
    open_tags_view()
    open_tag(FP + "/a1")
    record("with a tag tab active neither tool button is pressed and the outline is gone",
           pressed("Query") == "false" and pressed("Script Console") == "false" and outline_count() == 0,
           (pressed("Query"), pressed("Script Console"), outline_count()))
    st = secondary_toggle()
    record("...and the secondary side bar toggle reads not pressed, aria-disabled, with the reason in its name",
           st.get_attribute("aria-pressed") == "false" and st.get_attribute("aria-disabled") == "true"
           and "unavailable" in (st.get_attribute("aria-label") or ""),
           (st.get_attribute("aria-pressed"), st.get_attribute("aria-disabled"), st.get_attribute("aria-label")))
    activity_btn("Script Console").click()
    record("returning to the console tab: its output is exactly as it was",
           page.locator(".console-output").inner_text() == out_before, page.locator(".console-output").inner_text()[:200])
    record("...and Script Console is pressed again, Query not",
           pressed("Script Console") == "true" and pressed("Query") == "false")
    activity_btn("Query").click()
    page.wait_for_selector(".qb-editor .cm-content", timeout=10000)
    record("returning to the Query tab: the SQL buffer is intact",
           "zz_e2e_marker" in page.locator(".qb-editor .cm-content").inner_text(), page.locator(".qb-editor .cm-content").inner_text())

    # ---- outline back for a script
    activity_btn("Scripting").click()
    page.wait_for_selector(".file-tree-header", timeout=10000)
    for _ in range(6):
        shut = page.locator('.file-tree [aria-expanded="false"]')
        n = shut.count()
        if n == 0:
            break
        for i in range(n):
            try:
                shut.nth(i).click(timeout=2000)
            except Exception:  # noqa: BLE001
                pass
        page.wait_for_timeout(120)
    items = page.locator(".file-tree-item")
    if items.count() == 0:
        print("      NOTE: no script on the gateway to open; outline-for-a-script check skipped")
    else:
        items.first.click()
        got = until(lambda: outline_count() == 1, 10)
        record("with a script tab active the outline is back", bool(got), outline_count())
        st = secondary_toggle()
        record("...and the secondary side bar toggle is pressed and enabled again",
               st.get_attribute("aria-pressed") == "true" and st.get_attribute("aria-disabled") is None,
               (st.get_attribute("aria-pressed"), st.get_attribute("aria-disabled")))
        activity_btn("Query").click()
        page.wait_for_selector(".qb-editor .cm-content", timeout=10000)
        record("outline hidden again on the Query tab", outline_count() == 0, outline_count())

    # ---- move a tool tab to the split pane, state intact
    activity_btn("Script Console").click()
    page.wait_for_selector(".console-editor .cm-content", timeout=10000)
    pane(0).locator(".tab-strip-action").click()
    got = until(lambda: page.locator(".workspace-pane").count() == 2, 6)
    record("Split on the console tab opens a second pane", bool(got))
    record("the console moved to the right pane with its output intact",
           got and pane(1).locator(".console").count() == 1 and pane(1).locator(".console-output").inner_text() == out_before,
           pane(1).locator(".console-output").inner_text()[:200] if got else "")
    g = pg().evaluate("""() => { const b = document.querySelectorAll('.workspace-pane')[1].querySelector('.tool-tab-body');
        const p = b.closest('.workspace-pane').getBoundingClientRect(), r = b.getBoundingClientRect();
        return {h: r.height, gapBottom: p.bottom - r.bottom}; }""") if got else None
    record("...and fills the right pane's height", g and g["gapBottom"] <= 3 and g["h"] > 300, g)
    record("the Query tab (and its SQL) stayed in the left pane",
           pane(0).locator(".qb").count() == 0 or "zz_e2e_marker" in pane(0).locator(".qb-editor .cm-content").inner_text())
    activity_btn("Query").click()
    page.wait_for_selector(".qb-editor .cm-content", timeout=10000)
    record("the SQL buffer is still intact after the other tool moved",
           "zz_e2e_marker" in page.locator(".qb-editor .cm-content").inner_text())
    if got:
        pane(1).locator(".tab-strip-action").click()
        until(lambda: page.locator(".workspace-pane").count() == 1, 6)
        activity_btn("Script Console").click()
        record("moving it back keeps the output too",
               page.locator(".console-output").inner_text() == out_before)

    # ---- pop-out
    for label, view in (("Script Console", "console"), ("Query", "query")):
        activity_btn(label).click()
        page.wait_for_selector(".tab-strip-popout", timeout=5000)
        try:
            with C.context.expect_page(timeout=30000) as info:
                page.locator(".tab-strip-popout").click()
            newp = info.value
            url = newp.url
            record(f"New browser tab on {label} opens ?view={view} in a new page", f"view={view}" in url, url)
            newp.close()
        except Exception as e:  # noqa: BLE001
            record(f"New browser tab on {label} opens ?view={view} in a new page", False, e)
        record(f"...and the {label} tab closes in this page", label not in tabs(), tabs())
    close_all_tabs()


# ======================================================================
# F. split-pane tag editing
# ======================================================================

def pane_field(n, label, sect):
    return pane(n).locator(f'section.tag-form-section[aria-label="{sect}"]').get_by_label(label, exact=True)


def split_tag_checks():
    print("F. SPLIT-PANE TAG EDITING")
    page = pg()
    page.set_viewport_size({"width": 1366, "height": 640})
    delete(FP)
    create(ROOT, {"name": F, "tagType": "Folder", "tags": [atomic("s1", "Int4", 1), atomic("s2", "Int4", 2)]}, "Abort")
    page.reload(wait_until="load")
    page.wait_for_selector(".activity-bar", timeout=20000)
    close_all_tabs()
    S1, S2 = FP + "/s1", FP + "/s2"
    open_tags_view()
    open_tag(S1)
    pane(0).locator(".tab-strip-action").click()
    got = until(lambda: page.locator(".workspace-pane").count() == 2, 6)
    record("splitting a tag tab opens a second pane", bool(got))
    if not got:
        return
    record("the tag moved to the right pane", pane(1).locator(f'section.tag-doc[aria-label="Tag {S1}"]').count() == 1)
    open_tag(S2)
    page.wait_for_timeout(500)
    record("a second tag opens in the left pane", pane(0).locator(f'section.tag-doc[aria-label="Tag {S2}"]').count() == 1)
    for n, path in ((0, S2), (1, S1)):
        form = pane(n).locator(f'section.tag-doc[aria-label="Tag {path}"]')
        box = form.bounding_box() if form.count() else None
        nsec = pane(n).locator(".tag-form-section").count()
        vis = pane(n).locator(".tag-form-section").first.is_visible() if nsec else False
        record(f"pane {n} ({'left' if n == 0 else 'right'}) renders the form for {path.rsplit('/', 1)[1]}: sections present, visible, not blank",
               nsec >= 5 and vis and box and box["width"] > 100 and box["height"] > 100, (nsec, vis, box))
        record(f"pane {n}'s Value field shows the tag's own value",
               pane_field(n, "Value", "Value").input_value() == ("2" if path == S2 else "1"), pane_field(n, "Value", "Value").input_value())
    # edit both, save each with Ctrl+S in its own pane
    pane_field(0, "Documentation", "Metadata").fill("left-pane edit")
    pane_field(0, "Documentation", "Metadata").press("Control+s")
    ok = wait_saved(S2, lambda e: e["local_obj"].get("documentation") == "left-pane edit")
    record("Ctrl+S in the left pane saves the left tag (verified through the API)", bool(ok), ok and ok["local_obj"])
    pane_field(1, "Documentation", "Metadata").fill("right-pane edit")
    pane_field(1, "Value", "Value").fill("11")
    pane_field(1, "Value", "Value").press("Control+s")
    ok = wait_saved(S1, lambda e: e["local_obj"].get("documentation") == "right-pane edit" and e["local_obj"].get("value") == 11)
    record("Ctrl+S in the right pane saves the right tag (documentation and value 11, via the API)", bool(ok), ok and ok["local_obj"])
    record("...and neither save leaked into the other tag",
           edit(S2)["local_obj"].get("documentation") == "left-pane edit" and edit(S2)["local_obj"].get("value") == 2
           and edit(S1)["local_obj"].get("documentation") == "right-pane edit")
    until(lambda: page.locator(".tab-strip .tab .tab-dirty").count() == 0, 5)
    record("both panes' tabs are clean after saving", page.locator(".tab-strip .tab .tab-dirty").count() == 0)
    # a tag parked in the unfocused pane is not blank: focus the left pane and look at the right again
    pane(0).locator(".tag-form-label").first.click()
    page.wait_for_timeout(300)
    nsec = pane(1).locator(".tag-form-section").count()
    record("with focus in the left pane the right pane's tag form is still rendered (not blank)",
           nsec >= 5 and pane(1).locator(".tag-form-section").first.is_visible(), nsec)
    # Every header control must be inside its header and pane - a narrow pane
    # once wrapped Reload/Save tag onto a second line the header was squeezed
    # back over, so they rendered behind the form.
    for i in (0, 1):
        clipped = pane(i).locator(".tag-doc-header").evaluate("""h => {
          const hr = h.getBoundingClientRect(), pr = h.parentElement.getBoundingClientRect();
          return [...h.querySelectorAll('button')].filter(b => {
            const r = b.getBoundingClientRect();
            return r.top < hr.top - 0.5 || r.bottom > hr.bottom + 0.5 || r.left < pr.left - 0.5 || r.right > pr.right + 0.5;
          }).map(b => b.textContent.trim()); }""")
        record(f"pane {i}: every tag header button (Properties, JSON, Reload, Save tag) is fully visible", clipped == [], clipped)
    page.screenshot(path=str(SHOTS / "06-split-pane-tags.png"))
    audit("1366x640 split-pane tag editing")
    close_all_tabs()
    until(lambda: page.locator(".workspace-pane").count() == 1, 5)


# ======================================================================
# G. theme sweep
# ======================================================================

JS_CONTRAST = """() => {
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return p.length >= 3 ? {rgb: p.slice(0, 3), a: p.length >= 4 ? p[3] : 1} : null; };
  const mix = (top, a, bottom) => [0, 1, 2].map((k) => top[k] * a + bottom[k] * (1 - a));
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
    }
    let out = layers.length && layers[layers.length - 1].a >= 0.999 ? layers[layers.length - 1].rgb : [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) { if (layers[i].a < 0.999 || i < layers.length - 1) out = mix(layers[i].rgb, layers[i].a, out); }
    return out;
  };
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const out = [];
  const seen = new Set();
  const measure = (el, text, kind) => {
    if (seen.has(el)) return; seen.add(el);
    const r = el.getBoundingClientRect(); if (r.width < 3 || r.height < 3) return;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') return;
    if (el.closest('.visually-hidden, .tag-form-sr') || el.disabled) return;
    const fg = parse(cs.color); if (!fg) return;
    const bg = bgOf(el);
    const ink = fg.a < 0.999 ? mix(fg.rgb, fg.a, bg) : fg.rgb;
    out.push({kind, text: String(text).trim().slice(0, 30), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 36),
              ratio: Math.round(ratio(ink, bg) * 100) / 100});
  };
  for (const root of document.querySelectorAll('.tag-tree-rows, .tag-form')) {
    const kind = root.classList.contains('tag-form') ? 'form' : 'tree';
    for (const el of root.querySelectorAll('*')) {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
        if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'hidden') continue;
        const t = el.tagName === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].text : '') : el.value;
        if (String(t).trim()) measure(el, t, kind + '-input');
        continue;
      }
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent).join(' ');
      if (own.trim()) measure(el, own, kind);
    }
  }
  return out;
}"""


def theme_checks():
    print("G. THEME SWEEP")
    page = pg()
    page.set_viewport_size({"width": 1366, "height": 640})
    delete(FP)
    create(ROOT, {"name": F, "tagType": "Folder", "tags": [
        {"name": "m1", "tagType": "UdtInstance", "typeId": UDT, "tags": [{"name": "Speed", "value": 7.5}]},
        atomic("a1", "Int4", 1), atomic("a2", "Float8", 2.5),
        {"name": "sub", "tagType": "Folder", "tags": [atomic("leaf", "Int4", 9)]},
    ]}, "Abort")
    page.reload(wait_until="load")
    page.wait_for_selector(".activity-bar", timeout=20000)
    close_all_tabs()
    shots_dir = SHOTS / "themes"
    shots_dir.mkdir(parents=True, exist_ok=True)
    sel = page.locator('select[aria-label="Theme"]')
    original = sel.input_value()
    ids = sel.locator("option").evaluate_all("e => e.map(x => x.value)")
    print(f"      {len(ids)} themes; original is {original}")
    record("the theme picker lists every theme in themes.ts (10)", len(ids) == 10, ids)
    open_tags_view()
    expand(FP + "/m1")
    expand(FP + "/sub")
    open_tag(FP + "/m1/Speed")
    props_tab()
    summary = []
    try:
        for tid in ids:
            sel.select_option(tid)
            page.wait_for_timeout(500)
            tag = f"theme {tid}"
            record(f"{tag}: Properties tab of the UDT member is showing with the tree expanded",
                   page.locator(".tag-form-section").count() >= 5 and page.locator(".tag-tree-row").count() >= 6)
            audit(tag)
            rows = page.evaluate(JS_CONTRAST)
            bad = [r for r in rows if r["ratio"] < 4.5]
            worst = min(rows, key=lambda r: r["ratio"]) if rows else None
            kinds = {k: sum(1 for r in rows if r["kind"].startswith(k)) for k in ("form", "tree")}
            record(f"{tag}: tag-form and tree-row text all >= 4.5:1 ({len(rows)} elements measured; worst "
                   f"{worst['ratio'] if worst else 'n/a'})",
                   rows and kinds["form"] >= 8 and kinds["tree"] >= 4 and not bad,
                   {"measured": kinds, "below": sorted(bad, key=lambda r: r["ratio"])[:5]})
            summary.append((tid, worst["ratio"] if worst else None, len(bad), worst))
            page.screenshot(path=str(shots_dir / f"{tid}.png"))
    finally:
        sel.select_option(original)
        page.wait_for_timeout(400)
    record("the original theme is restored", sel.input_value() == original, sel.input_value())
    print("      theme            worst-contrast  below-4.5  worst element")
    for tid, w, nbad, el in summary:
        print(f"      {tid:26} {w}  {nbad}  {el and (el['cls'], el['text'])}")
    close_all_tabs()


if __name__ == "__main__":
    sys.exit(main())
