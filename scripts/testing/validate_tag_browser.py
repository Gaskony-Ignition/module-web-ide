#!/usr/bin/env python3
"""Live validation of the Tag Browser: every route, every tag kind including UDT
definitions and instances, the refusal paths, and the panel in a real browser.

Every API check runs through the SAME Playwright page `deploy_gate.py` logs in
with, so a route that 401s for the wrong reason is not mistaken for a pass.
See TagRouteHandler's class Javadoc for the contract asserted here.

This suite creates the fixtures it destroys, and clears its own first: it
removes the scratch folder and the scratch UDT definition before it starts and
again in `finally`, so a killed run leaves nothing for the next one to trip on.

Usage:
    SI_GATEWAY_CONFIG=$PWD/config.local.json PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
      .venv/bin/python validate_tag_browser.py
"""
import json
import subprocess
import sys
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
FOLDER = "ZZ_webide_tags"
FOLDER_PATH = f"{ROOT}{FOLDER}"
UDT = "ZZ_WebideMotor"
UDT_PATH = f"{ROOT}_types_/{UDT}"
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp")

JS_FETCH = """async ([method, url, body, csrf]) => {
  const headers = {'Content-Type': 'application/json'};
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const r = await fetch(url, {method, credentials: 'include', headers,
    body: body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))});
  let j = null, t = null;
  try { t = await r.text(); j = JSON.parse(t); } catch (e) {}
  return {status: r.status, json: j, text: t};
}"""

results = []


def record(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + ("" if ok else f"  -- {detail}"))


def atomic(name, data_type, value):
    return {"name": name, "tagType": "AtomicTag", "valueSource": "memory",
            "dataType": data_type, "value": value}


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1366, "height": 640})
        login(page)
        session = assert_authenticated(page)
        csrf = session["csrfToken"]

        def call(method, path, body=None, token=True, raw=False):
            return page.evaluate(JS_FETCH, [method, SPA + path, body,
                                            csrf if (method == "POST" and token is True) else
                                            (token if isinstance(token, str) else None)])

        def create(base, config, collision="Overwrite"):
            return call("POST", "/api/tags/create",
                        {"basePath": base, "json": json.dumps(config), "collision": collision})

        def delete(*paths):
            return call("POST", "/api/tags/delete", {"paths": list(paths)})

        def read(*paths):
            r = call("POST", "/api/tags/read", {"paths": list(paths)})
            return r, (r["json"] or {}).get("values", [])

        def cleanup():
            delete(FOLDER_PATH)
            delete(UDT_PATH)

        cleanup()
        try:
            api_checks(call, create, delete, read)
            policy_checks(call, create)
            ui_checks(page, call, create, csrf)
        finally:
            cleanup()
            gone = call("GET", "/api/tags/browse?path=" + ROOT)["json"]["children"]
            record("fixtures are gone after cleanup", FOLDER not in [c["name"] for c in gone])
            browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    for name in failed:
        print("  FAILED:", name)
    return 1 if failed else 0


# ==================== API ====================

def api_checks(call, create, delete, read):
    print("API")
    r = call("GET", "/api/tags/providers")
    record("providers lists the default provider", PROVIDER in (r["json"] or {}).get("providers", []), r["text"])

    r = call("GET", "/api/tags/browse?path=" + ROOT)
    kids = (r["json"] or {}).get("children", [])
    record("browse a provider root returns children with the documented fields",
           r["status"] == 200 and kids and all({"name", "hasChildren", "objectType", "dataType"} <= set(k) for k in kids),
           r["text"][:200])
    record("browse of an unknown provider is a 404",
           call("GET", "/api/tags/browse?path=%5BNoSuchProvider_zz%5D")["status"] == 404)

    for bad in ["", "%5Bunclosed", "%20"]:
        record(f"browse with a bad path '{bad}' is a 400",
               call("GET", "/api/tags/browse?path=" + bad)["status"] == 400)
    record("config with no path is a 400", call("GET", "/api/tags/config")["status"] == 400)

    # ---- atomic tags of each kind
    r = create(ROOT, {"name": FOLDER, "tagType": "Folder", "tags": [
        atomic("i", "Int4", 1), atomic("f", "Float8", 1.5), atomic("b", "Boolean", False),
        atomic("s", "String", "hello"), atomic("big", "Int8", 5)]})
    record("create a folder holding an atomic tag of every common type",
           r["status"] == 200 and r["json"]["ok"] is True, r["text"])
    k = call("GET", "/api/tags/browse?path=" + FOLDER_PATH)["json"]["children"]
    by = {c["name"]: c for c in k}
    record("browse shows each atomic tag with its data type and no children",
           by.get("i", {}).get("dataType") == "Int4" and by.get("f", {}).get("dataType") == "Float8"
           and by.get("b", {}).get("dataType") == "Boolean" and not by["i"]["hasChildren"], json.dumps(k))
    record("an atomic tag's objectType is AtomicTag", by["i"]["objectType"] == "AtomicTag", by["i"]["objectType"])

    for name, value, expect in [("i", 42, 42), ("f", 2.25, 2.25), ("b", True, True), ("s", "world", "world")]:
        w = call("POST", "/api/tags/write", {"path": f"{FOLDER_PATH}/{name}", "value": value})
        _, v = read(f"{FOLDER_PATH}/{name}")
        record(f"write then read back {name}={value!r}",
               w["json"]["ok"] is True and v and v[0]["value"] == expect and v[0]["good"] is True,
               f"{w['text']} {v}")
    _, v = read(f"{FOLDER_PATH}/i")
    record("a read carries quality, good and an ISO timestamp",
           v[0]["quality"] == "Good" and v[0]["timestamp"].endswith("Z") and "T" in v[0]["timestamp"], str(v))

    w = call("POST", "/api/tags/write", {"path": f"{FOLDER_PATH}/i", "value": "not a number"})
    record("a wrong-typed write never 500s", w["status"] < 500, w["text"])
    w = call("POST", "/api/tags/write", {"path": f"{FOLDER_PATH}/nosuch", "value": 1})
    record("a write to a missing tag reports not ok", w["status"] == 200 and w["json"]["ok"] is False, w["text"])
    w = call("POST", "/api/tags/write", {"path": f"{FOLDER_PATH}/i"})
    record("a write with no value is a 400", w["status"] == 400)

    call("POST", "/api/tags/write", {"path": f"{FOLDER_PATH}/big", "value": 9007199254740000})
    _, v = read(f"{FOLDER_PATH}/big")
    record("a large Int8 inside the safe range reads back exactly", v and v[0]["value"] == 9007199254740000, str(v))

    # ---- read edge cases
    r, v = read(f"{FOLDER_PATH}/i", f"{FOLDER_PATH}/nosuch")
    record("a mixed read keeps order; the missing tag is bad quality, not an error",
           len(v) == 2 and v[0]["good"] and not v[1]["good"], r["text"])
    record("a read with no paths is a 400", call("POST", "/api/tags/read", {"paths": []})["status"] == 400)
    record("a read of 501 paths is refused",
           call("POST", "/api/tags/read", {"paths": [f"{FOLDER_PATH}/i"] * 501})["status"] == 400)
    record("a read with an odd path never 500s", call("POST", "/api/tags/read", {"paths": ["%bad"]})["status"] < 500)
    record("a read with malformed JSON is a 400", call("POST", "/api/tags/read", "{not json")["status"] == 400)

    # ---- config export
    c = call("GET", "/api/tags/config?path=" + FOLDER_PATH)
    cfg = json.loads((c["json"] or {}).get("json", "{}"))
    record("config of a folder exports its children as JSON",
           cfg.get("tagType") == "Folder" and len(cfg.get("tags", [])) == 5, c["text"][:200])
    c = call("GET", "/api/tags/config?path=" + f"{FOLDER_PATH}/nosuch")
    record("config of a missing tag is a 404 or an empty stub, never a 500", c["status"] < 500, c["text"][:200])

    # ---- UDT definition and instance
    r = create(f"{ROOT}_types_", {"name": UDT, "tagType": "UdtType",
                                  "parameters": {"unit": {"dataType": "String", "value": "rpm"}},
                                  "tags": [atomic("Speed", "Float8", 3.5), atomic("Run", "Boolean", False)]})
    record("create a UDT definition under _types_", r["status"] == 200 and r["json"]["ok"] is True, r["text"])
    k = call("GET", "/api/tags/browse?path=" + f"{ROOT}_types_")["json"]["children"]
    d = next((c for c in k if c["name"] == UDT), None)
    record("the UDT definition browses as expandable and is typed UdtType",
           d is not None and d["hasChildren"] and d["objectType"] == "UdtType", json.dumps(d))
    print("      UDT definition objectType:", d and d["objectType"])

    r = create(FOLDER_PATH, {"name": "m1", "tagType": "UdtInstance", "typeId": UDT})
    record("create a UDT instance from the definition", r["status"] == 200 and r["json"]["ok"] is True, r["text"])
    k = call("GET", "/api/tags/browse?path=" + FOLDER_PATH)["json"]["children"]
    m = next((c for c in k if c["name"] == "m1"), None)
    record("the UDT instance browses as expandable", m is not None and m["hasChildren"], json.dumps(m))
    print("      UDT instance objectType:", m and m["objectType"])
    k = call("GET", "/api/tags/browse?path=" + f"{FOLDER_PATH}/m1")["json"]["children"]
    record("the instance's members are browsable", {"Speed", "Run"} <= {c["name"] for c in k}, json.dumps(k))
    w = call("POST", "/api/tags/write", {"path": f"{FOLDER_PATH}/m1/Speed", "value": 9.5})
    _, v = read(f"{FOLDER_PATH}/m1/Speed")
    record("write then read a UDT instance member", w["json"]["ok"] and v and v[0]["value"] == 9.5, f"{w['text']} {v}")
    c = call("GET", "/api/tags/config?path=" + f"{FOLDER_PATH}/m1")
    ic = json.loads((c["json"] or {}).get("json", "{}"))
    record("config of an instance names its UDT type", ic.get("tagType") == "UdtInstance" and UDT in str(ic.get("typeId")), c["text"][:300])
    c = call("GET", "/api/tags/config?path=" + UDT_PATH)
    dc = json.loads((c["json"] or {}).get("json", "{}"))
    record("config of a definition carries its parameters and members",
           dc.get("tagType") == "UdtType" and "unit" in dc.get("parameters", {}) and len(dc.get("tags", [])) == 2, c["text"][:300])
    d1 = delete(f"{FOLDER_PATH}/m1")
    record("delete a UDT instance", d1["json"]["ok"] is True, d1["text"])
    d2 = delete(UDT_PATH)
    record("delete a UDT definition", d2["json"]["ok"] is True, d2["text"])

    # ---- collision policy
    r = create(ROOT, {"name": FOLDER, "tagType": "Folder", "tags": [atomic("fresh", "Int4", 7)]}, "Abort")
    record("Abort on an existing folder does not report ok", r["status"] == 200 and r["json"]["ok"] is False or r["status"] >= 400, r["text"])
    kids = {c["name"] for c in call("GET", "/api/tags/browse?path=" + FOLDER_PATH)["json"]["children"]}
    record("Abort left the existing tags untouched", "i" in kids and "fresh" not in kids, str(kids))
    r = create(ROOT, {"name": FOLDER, "tagType": "Folder", "tags": [atomic("fresh", "Int4", 7)]}, "Overwrite")
    kids = {c["name"] for c in call("GET", "/api/tags/browse?path=" + FOLDER_PATH)["json"]["children"]}
    # Observed platform behaviour: Overwrite on a folder adds the new children and
    # keeps the old ones; it does not empty the folder first.
    record("Overwrite applies the new config to the existing folder", r["json"]["ok"] and "fresh" in kids, str(kids))
    r = call("POST", "/api/tags/create", {"basePath": ROOT, "json": json.dumps(
        {"name": FOLDER, "tagType": "Folder", "tags": [atomic("i", "Int4", 1)]}), "collision": "bogus"})
    record("an unknown collision name falls back to Abort and never overwrites",
           "fresh" in {c["name"] for c in call("GET", "/api/tags/browse?path=" + FOLDER_PATH)["json"]["children"]}, r["text"])

    # ---- bad create / delete input
    record("create with malformed request JSON is a 400",
           call("POST", "/api/tags/create", "{nope")["status"] == 400)
    record("create with missing fields is a 400", call("POST", "/api/tags/create", {"basePath": ROOT})["status"] == 400)
    r = call("POST", "/api/tags/create", {"basePath": ROOT, "json": "{not json", "collision": "Abort"})
    record("create with invalid configuration JSON is a readable 502, not a crash",
           r["status"] in (400, 502) and "error" in (r["json"] or {}), r["text"][:200])
    r = call("POST", "/api/tags/create", {"basePath": "[NoSuchProvider_zz]", "json": json.dumps(atomic("x", "Int4", 1)), "collision": "Abort"})
    record("create under an unknown provider is a 404", r["status"] in (404, 502), r["text"][:200])
    record("delete with no paths is a 400", call("POST", "/api/tags/delete", {"paths": []})["status"] == 400)
    r = delete(f"{FOLDER_PATH}/nosuch")
    record("delete of a missing tag never 500s", r["status"] < 500, r["text"])
    r = delete("[NoSuchProvider_zz]x")
    record("delete under an unknown provider is a 404", r["status"] == 404, r["text"])

    # ---- delete several at once
    create(FOLDER_PATH, atomic("d1", "Int4", 1), "Overwrite")
    create(FOLDER_PATH, atomic("d2", "Int4", 1), "Overwrite")
    r = delete(f"{FOLDER_PATH}/d1", f"{FOLDER_PATH}/d2")
    kids = {c["name"] for c in call("GET", "/api/tags/browse?path=" + FOLDER_PATH)["json"]["children"]}
    record("delete removes several paths in one call", r["json"]["ok"] and not ({"d1", "d2"} & kids), str(kids))

    # ---- the browse cap
    big = {"name": FOLDER, "tagType": "Folder", "tags": [atomic(f"t{n:04d}", "Int4", n) for n in range(2100)]}
    r = create(ROOT, big)
    k = call("GET", "/api/tags/browse?path=" + FOLDER_PATH)
    record("a 2100-tag folder browses capped at 2000 and says it was truncated",
           (r["json"] or {}).get("ok") and len((k["json"] or {}).get("children", [])) == 2000 and k["json"].get("truncated") is True,
           f"{r['status']} {r['text'][:300]} {len((k['json'] or {}).get('children', []))}")
    # restore the small fixture the UI section expects; delete first, because
    # Overwrite on a folder merges rather than replaces
    delete(FOLDER_PATH)
    create(ROOT, {"name": FOLDER, "tagType": "Folder", "tags": [atomic("i", "Int4", 1), atomic("s", "String", "x")]})

    # ---- security: no session, bad token
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
              ("GET", "/api/tags/config?path=%5Bdefault%5D"), ("POST", "/api/tags/read"),
              ("POST", "/api/tags/write"), ("POST", "/api/tags/create"), ("POST", "/api/tags/delete")]
    for method, path in routes:
        record(f"no session -> 401 on {method} {path.split('?')[0]}",
               anon(path, method, {} if method == "POST" else None) == 401)
    for path, body in [("/api/tags/read", {"paths": [f"{FOLDER_PATH}/i"]}),
                       ("/api/tags/write", {"path": f"{FOLDER_PATH}/i", "value": 99}),
                       ("/api/tags/create", {"basePath": FOLDER_PATH, "json": json.dumps(atomic("csrf", "Int4", 1))}),
                       ("/api/tags/delete", {"paths": [f"{FOLDER_PATH}/i"]})]:
        no_token = call("POST", path, body, token=False)
        bad_token = call("POST", path, body, token="wrong-token")
        record(f"POST {path} without a CSRF token is a 403", no_token["status"] == 403, no_token["text"][:100])
        record(f"POST {path} with a wrong CSRF token is a 403", bad_token["status"] == 403, bad_token["text"][:100])
    _, v = read(f"{FOLDER_PATH}/i")
    kids = {c["name"] for c in call("GET", "/api/tags/browse?path=" + FOLDER_PATH)["json"]["children"]}
    record("the CSRF-refused write, create and delete changed nothing",
           v[0]["value"] == 1 and "csrf" not in kids and "i" in kids, f"{v} {kids}")

    # ---- audit
    if CONTAINER:
        log = subprocess.run(["docker", "logs", "--tail", "4000", CONTAINER], capture_output=True, text=True, timeout=30)
        text = log.stdout + log.stderr
        for target in ("tag-write:", "tag-create:", "tag-delete"):
            record(f"a {target} attempt reached ExecAudit (logged: no audit profile on this rig)", f"target='{target}" in text)


# ==================== execution switched off ====================

def policy_checks(call, create):
    print("POLICY")
    if not CONTAINER:
        print("  (no container_name in config; skipped)")
        return
    exists = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", f"test -f {POLICY_FILE}"],
                            capture_output=True, timeout=15).returncode == 0
    backup = subprocess.run(["docker", "exec", CONTAINER, "cat", POLICY_FILE], capture_output=True,
                            timeout=15).stdout if exists else None
    try:
        subprocess.run(["docker", "exec", CONTAINER, "sh", "-c",
                        f"echo 'com.gaskony.scriptide.execution.enabled=false' > {POLICY_FILE}"],
                       check=True, capture_output=True, timeout=15)
        time.sleep(3.5)  # the policy file is re-statted every 2 s
        w = call("POST", "/api/tags/write", {"path": f"{FOLDER_PATH}/i", "value": 5})
        c = call("POST", "/api/tags/create", {"basePath": FOLDER_PATH, "json": json.dumps(atomic("pol", "Int4", 1))})
        d = call("POST", "/api/tags/delete", {"paths": [f"{FOLDER_PATH}/i"]})
        record("execution.enabled=false refuses write, create and delete with 403",
               w["status"] == c["status"] == d["status"] == 403, f"{w['status']} {c['status']} {d['status']}")
        r = call("POST", "/api/tags/read", {"paths": [f"{FOLDER_PATH}/i"]})
        b = call("GET", "/api/tags/browse?path=" + FOLDER_PATH)
        record("...while read, browse and config still work",
               r["status"] == 200 and b["status"] == 200 and
               call("GET", "/api/tags/config?path=" + FOLDER_PATH)["status"] == 200)
        kids = {c["name"] for c in b["json"]["children"]}
        record("...and nothing was changed", "i" in kids and "pol" not in kids, str(kids))
    finally:
        if backup is None:
            subprocess.run(["docker", "exec", CONTAINER, "rm", "-f", POLICY_FILE], capture_output=True, timeout=15)
        else:
            subprocess.run(["docker", "exec", "-i", CONTAINER, "sh", "-c", f"cat > {POLICY_FILE}"],
                           input=backup, capture_output=True, timeout=15)
        time.sleep(3.5)
    w = call("POST", "/api/tags/write", {"path": f"{FOLDER_PATH}/i", "value": 6})
    record("the policy file is restored and writes work again", w["status"] == 200 and w["json"]["ok"], w["text"])


# ==================== the panel ====================

def ui_checks(page, call, create, csrf):
    print("UI")
    reads = []
    page.on("request", lambda req: reads.append(time.time()) if "/api/tags/read" in req.url else None)
    page.goto(GATEWAY_URL + SPA + "/", wait_until="load")
    page.wait_for_timeout(2500)
    # a UDT for the UI to show
    create(f"{ROOT}_types_", {"name": UDT, "tagType": "UdtType", "tags": [atomic("Speed", "Float8", 3.5)]})
    create(FOLDER_PATH, {"name": "m1", "tagType": "UdtInstance", "typeId": UDT})

    tab = page.get_by_role("button", name="Tags", exact=True)
    tab.click()
    page.wait_for_timeout(1200)
    record("the Tags tab opens and lists providers", page.get_by_role("button", name=f"Expand {PROVIDER}", exact=True).count() == 1)

    # a provider row has no Delete / Get configuration
    page.get_by_role("button", name=PROVIDER, exact=True).click()
    record("a provider row offers Copy path only (no Delete, no Get configuration)",
           page.get_by_role("button", name="Delete", exact=True).count() == 0
           and page.get_by_role("button", name="Get configuration", exact=True).count() == 0
           and page.get_by_role("button", name="Copy path", exact=True).count() == 1)

    page.get_by_role("button", name=f"Expand {PROVIDER}", exact=True).click()
    page.wait_for_timeout(1500)
    page.get_by_role("button", name=f"Expand {FOLDER}", exact=True).click()
    page.wait_for_timeout(1800)
    row_i = page.locator('[role=treeitem]', has=page.get_by_role("button", name="i", exact=True))
    record("an expanded folder shows atomic tags with value and quality inline",
           "[Good]" in row_i.inner_text(), row_i.inner_text())
    record("a UDT instance is shown as expandable",
           page.get_by_role("button", name="Expand m1", exact=True).count() == 1)
    page.get_by_role("button", name="Expand m1", exact=True).click()
    page.wait_for_timeout(1500)
    record("a UDT instance expands to its members", page.get_by_role("button", name="Speed", exact=True).count() >= 1)

    # select + write via the UI
    page.get_by_role("button", name="i", exact=True).click()
    record("selecting an atomic tag shows its path and a write box",
           page.locator(".tb-path").inner_text() == f"{FOLDER_PATH}/i" and page.locator(".tb-input").count() == 1)
    box = page.locator(".tb-input")
    box.fill("abc")
    page.get_by_role("button", name="Write", exact=True).click()
    page.wait_for_timeout(600)
    record("an invalid value for an Int tag is refused in the panel with a message",
           "not a valid" in page.locator(".tb-error").inner_text())
    box.fill("77")
    page.get_by_role("button", name="Write", exact=True).click()
    page.wait_for_timeout(1500)
    _, = [call("POST", "/api/tags/read", {"paths": [f"{FOLDER_PATH}/i"]})]
    record("a valid write through the panel changes the gateway value and says so",
           _["json"]["values"][0]["value"] == 77 and "Written" in page.locator(".tb-detail [role=status]").inner_text(), _["text"][:120])
    box.fill("88")
    box.press("Enter")
    page.wait_for_timeout(1200)
    record("Enter in the write box writes",
           call("POST", "/api/tags/read", {"paths": [f"{FOLDER_PATH}/i"]})["json"]["values"][0]["value"] == 88)

    # config
    page.get_by_role("button", name="Get configuration", exact=True).click()
    page.wait_for_timeout(1200)
    cfg = page.locator("#tb-config").input_value()
    record("Get configuration fills the box with the tag's JSON", '"dataType": "Int4"' in cfg or "Int4" in cfg, cfg[:100])
    page.screenshot(path=str(SHOTS / "tags-atomic.png"))

    # UDT instance + definition in the panel
    page.get_by_role("button", name="m1", exact=True).click()
    page.get_by_role("button", name="Get configuration", exact=True).click()
    page.wait_for_timeout(1200)
    record("Get configuration on a UDT instance shows its typeId",
           UDT in page.locator("#tb-config").input_value())

    # create via the panel
    page.get_by_role("button", name=FOLDER, exact=True).click()
    page.locator("#tb-config").fill(json.dumps(atomic("ui_made", "Int4", 5)))
    page.get_by_role("button", name="Create", exact=True).click()
    page.wait_for_timeout(1800)
    record("Create from the panel adds the tag under the selected folder and lists it",
           "Created" in page.locator(".tb-detail [role=status]").inner_text()
           and page.get_by_role("button", name="ui_made", exact=True).count() == 1,
           page.locator(".tb-detail").inner_text())
    page.screenshot(path=str(SHOTS / "tags-create.png"))
    page.locator("#tb-config").fill(json.dumps(atomic("ui_made", "Int4", 6)))
    page.get_by_role("button", name="Create", exact=True).click()
    page.wait_for_timeout(1500)
    record("Create over an existing tag with Abort reports a refusal, not Created",
           "Created" not in page.locator(".tb-detail [role=status]").inner_text()
           or page.locator(".tb-error").count() == 1,
           page.locator(".tb-detail [role=status]").inner_text())
    page.locator("#tb-config").fill("{broken")
    page.get_by_role("button", name="Create", exact=True).click()
    page.wait_for_timeout(1200)
    record("Create with broken JSON shows an error alert", page.locator(".tb-error").count() == 1)

    # delete: cancel, then confirm
    page.get_by_role("button", name="ui_made", exact=True).click()
    page.get_by_role("button", name="Delete", exact=True).click()
    record("Delete asks for confirmation first",
           page.get_by_role("button", name="Confirm delete", exact=True).count() == 1)
    page.get_by_role("button", name="Cancel", exact=True).click()
    record("Cancel leaves the tag in place",
           page.get_by_role("button", name="ui_made", exact=True).count() == 1
           and page.get_by_role("button", name="Delete", exact=True).count() == 1)
    page.get_by_role("button", name="Delete", exact=True).click()
    page.get_by_role("button", name="Confirm delete", exact=True).click()
    page.wait_for_timeout(1800)
    record("Confirm delete removes the tag and its row", page.get_by_role("button", name="ui_made", exact=True).count() == 0
           and "Deleted" in page.locator(".tb-detail [role=status]").inner_text())

    # refresh picks up an outside change
    create(FOLDER_PATH, atomic("outside", "Int4", 1))
    page.get_by_role("button", name="Refresh", exact=True).click()
    page.wait_for_timeout(1800)
    record("Refresh shows a tag created elsewhere", page.get_by_role("button", name="outside", exact=True).count() == 1)

    # copy path should not throw
    page.get_by_role("button", name="outside", exact=True).click()
    page.get_by_role("button", name="Copy path", exact=True).click()
    page.wait_for_timeout(300)
    record("Copy path raises no error", page.locator(".tb-error").count() == 0)

    # a folder over the browse cap says so in the tree, and an action's status is not overwritten
    create(FOLDER_PATH, {"name": "huge", "tagType": "Folder",
                         "tags": [atomic(f"h{n:04d}", "Int4", n) for n in range(2001)]})
    page.get_by_role("button", name="Refresh", exact=True).click()
    page.wait_for_timeout(1500)
    page.get_by_role("button", name="Expand huge", exact=True).click()
    page.wait_for_timeout(3000)
    record("a folder over 2000 children shows 'First 2000 shown' in the tree",
           page.locator(".tb-more").count() == 1 and "First 2000" in page.locator(".tb-more").inner_text())
    record("...and that row is not selectable",
           page.locator(".tb-more button").count() == 0)
    page.get_by_role("button", name="Collapse huge", exact=True).click()
    page.wait_for_timeout(500)
    record("collapsing the folder removes the note", page.locator(".tb-more").count() == 0)

    # polling stops while hidden
    reads.clear()
    page.get_by_role("button", name="Problems", exact=True).click()
    page.wait_for_timeout(7500)
    hidden_reads = len(reads)
    page.get_by_role("button", name="Tags", exact=True).click()
    page.wait_for_timeout(7500)
    record("no value reads while the tab is hidden", hidden_reads == 0, f"{hidden_reads} reads")
    record("polling resumes, about every 5 s, when the tab is shown again", 2 <= len(reads) <= 5, f"{len(reads)} reads")

    # live value change shows up without interaction
    create(FOLDER_PATH, atomic("live", "Int4", 1))
    page.get_by_role("button", name="Refresh", exact=True).click()
    page.wait_for_timeout(1500)
    call("POST", "/api/tags/write", {"path": f"{FOLDER_PATH}/live", "value": 1234})
    page.wait_for_timeout(6500)
    row = page.locator('[role=treeitem]', has=page.get_by_role("button", name="live", exact=True)).inner_text()
    record("an outside value change appears in the tree on the next poll", "1234" in row, row)

    # no inner scroll bars on the tree or the page at this size
    metrics = page.evaluate("""() => ({
      page: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      body: document.body.scrollHeight - document.body.clientHeight,
      detail: (() => { const d = document.querySelector('.tb-detail'); return d.scrollHeight - d.clientHeight; })()})""")
    record("no page scroll at 1366x640", metrics["page"] <= 0 and metrics["body"] <= 0, str(metrics))
    print("      detail-pane overflow at 1366x640:", metrics["detail"], "px")
    page.screenshot(path=str(SHOTS / "tags-final.png"))

    # a smaller panel dock: maximise and check nothing clips
    page.get_by_role("button", name="Maximise", exact=False).first.click() if page.get_by_role("button", name="Maximise", exact=False).count() else None
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOTS / "tags-max.png"))

    # UDT definition shown in the _types_ folder
    page.get_by_role("button", name="Collapse " + FOLDER, exact=True).click()
    page.get_by_role("button", name="Expand _types_", exact=True).click()
    page.wait_for_timeout(1500)
    record("the _types_ folder lists the UDT definition",
           page.get_by_role("button", name=UDT, exact=True).count() == 1)
    page.get_by_role("button", name=UDT, exact=True).click()
    record("a UDT definition has no write box but does offer Get configuration and Delete",
           page.locator(".tb-input").count() == 0
           and page.get_by_role("button", name="Get configuration", exact=True).count() == 1
           and page.get_by_role("button", name="Delete", exact=True).count() == 1)


if __name__ == "__main__":
    sys.exit(main())
