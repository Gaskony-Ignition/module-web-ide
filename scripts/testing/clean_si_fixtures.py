"""Remove this module's own leftover `_si_*` test fixtures from a project.

Crashed suite runs leave their fixture packages behind. They are harmless until
one of them shares a LEAF NAME with a live fixture: a v27 orphan called `beta`
once made a v30 tree-click open a file the suite had never written, and the
failure read exactly like a presence regression. Suites now prefix their leaf
names, so this is tidying rather than a fix — but the litter is still ours.

Deletes through the module's own DELETE route, not by removing directories in
the container, so the gateway updates its own resource state instead of finding
out at the next scan.

Only paths under `ignition/script-python/_si_` are touched. The prefix is this
module's test namespace and nothing a person writes uses it.

Run:
    SI_GATEWAY_CONFIG=$PWD/scripts/testing/config.local.json \
      .venv-test/bin/python scripts/testing/clean_si_fixtures.py [--dry-run]
"""
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gateway_session import CONFIG, GATEWAY_URL, login          # noqa: E402
from playwright.sync_api import sync_playwright                 # noqa: E402

SPA = CONFIG.get("spa_path", "/data/scriptide/")
PROJECT = os.environ.get("SI_EDIT_PROJECT", "Mining_Demo")
PREFIX = "ignition/script-python/_si_"
DRY_RUN = "--dry-run" in sys.argv


def q(value):
    return urllib.parse.quote(str(value), safe="")


def api(page, method, path):
    return page.evaluate(
        """async ([spa, method, path]) => {
            const res = await fetch(spa + path, {method, credentials: 'include'});
            return {status: res.status, text: await res.text()};
        }""",
        [SPA, method, path])


def tree(page):
    raw = api(page, "GET", f"api/scripts?project={q(PROJECT)}")
    try:
        return json.loads(raw["text"]).get("scripts", [])
    except (ValueError, KeyError, TypeError):
        return []


def orphans(page):
    """Fixtures deepest-first, so a package is empty before it is removed."""
    found = [e for e in tree(page) if str(e.get("path", "")).startswith(PREFIX)]
    return sorted(found, key=lambda e: e["path"].count("/"), reverse=True)


print(f"Cleaning `_si_` fixtures from {PROJECT} on {GATEWAY_URL}"
      f"{' (DRY RUN)' if DRY_RUN else ''}")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
    login(page)
    page.goto(GATEWAY_URL + SPA, wait_until="load", timeout=30000)
    page.wait_for_selector(".file-tree-header", timeout=20000)
    csrf = page.evaluate(
        "async (spa) => (await (await fetch(spa + 'api/auth/session',"
        " {credentials:'include'})).json()).csrfToken", SPA)
    page.select_option(".workspace-project select", PROJECT)
    page.wait_for_timeout(1200)

    targets = orphans(page)
    if not targets:
        print("  nothing to remove")
        browser.close()
        raise SystemExit(0)

    print(f"  {len(targets)} fixture resource(s):")
    for entry in targets:
        print(f"    {entry['path']}")
    if DRY_RUN:
        browser.close()
        raise SystemExit(0)

    removed, refused = 0, []
    for entry in targets:
        result = page.evaluate(
            """async ([spa, url, csrf, ifMatch]) => {
                 const headers = {'X-CSRF-Token': csrf};
                 if (ifMatch) headers['If-Match'] = ifMatch;
                 const res = await fetch(spa + url,
                   {method: 'DELETE', credentials: 'include', headers});
                 return {status: res.status, text: await res.text()};
               }""",
            [SPA, f"api/scripts/content/{q(entry['path'])}?project={q(PROJECT)}",
             csrf, entry.get("signature")])
        if 200 <= result["status"] < 300:
            removed += 1
        else:
            refused.append((entry["path"], result["status"], result["text"][:120]))

    # The gateway's own listing is the check, not the delete responses: a 200
    # that left the resource in place is exactly the failure worth catching.
    left = [e["path"] for e in orphans(page)]
    print(f"  removed {removed}, still present {len(left)}")
    for path, status, text in refused:
        print(f"  [REFUSED] {path} -> {status} {text}")
    for path in left:
        print(f"  [LEFT] {path}")
    browser.close()
    raise SystemExit(1 if (refused or left) else 0)
