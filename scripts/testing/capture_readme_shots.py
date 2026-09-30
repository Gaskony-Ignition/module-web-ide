"""
Re-take the README's screenshots against the version that is actually deployed.

F3 in `docs/PRODUCT-REVIEW.md`: the README's screenshots were dated 01/09 — before
the themes pass, the split view, the Web Dev tree, named queries and the error
ruler. The house README standard puts screenshots ahead of the feature list
precisely because they are read first, so a stale one is the most expensive
stale thing in the repo.

This exists so they are never stale by accident again: it is a script, it runs
against the live gateway, and it writes into `docs/images/` in place.

**Deliberately not a check.** It asserts nothing and fails nothing — a
screenshot's correctness is a human judgement, and a suite that compared PNGs
would fail on a font hint. Run it after a release deploy, then LOOK at the files.

Run:
    SI_GATEWAY_CONFIG=$PWD/config.local.json \\
      .venv-test/bin/python scripts/testing/capture_readme_shots.py
"""
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gateway_session import CONFIG, GATEWAY_URL, login          # noqa: E402
from playwright.sync_api import sync_playwright                 # noqa: E402

SPA = CONFIG.get("spa_path", "/data/scriptide/")
PROJECT = os.environ.get("SI_EDIT_PROJECT", "Mining_Demo_1")

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGES = os.path.abspath(os.path.join(HERE, "..", "..", "docs", "images"))

SHOT_MODULE = "ignition/script-python/metallurgy/shift_totals"
TEST_MODULE = "ignition/script-python/metallurgy/test_totals"
# The package resource too — deleting the scripts inside leaves the folder, and
# an empty folder per run is exactly the debris these screenshots must not show.
FIXTURE_FOLDER = "ignition/script-python/metallurgy"
FIXTURES = (SHOT_MODULE, TEST_MODULE, FIXTURE_FOLDER)

# The Query Browser shot runs against a real configured datasource instead of
# the script fixtures above — a table already on the gateway, not one this
# script has to create and tear down.
QUERY_DATASOURCE = "Postgres_Test"
QUERY_TABLE = "alarm_events"
QUERY_SQL = "\n".join([
    "SELECT id, eventtime, priority, displaypath, source",
    "FROM alarm_events",
    "ORDER BY eventtime DESC",
    "LIMIT 20",
])

# The fixture names are deliberately PLAUSIBLE rather than obviously ours. An
# earlier pass used `_si_shots`, and the Tests panel puts the module name on
# screen — so the README's own screenshots advertised a test fixture in two
# places. A screenshot is a claim about what the tool looks like in use.

# A body worth photographing: enough shape to look like real code, short enough
# that the whole thing is on screen at 1600x1000.
DEMO_SOURCE = "\n".join([
    "\"\"\"Shift totals for the concentrator, read straight off the tag provider.\"\"\"",
    "",
    "SHIFT_TAGS = [",
    "\t'[default]Mill/Throughput',",
    "\t'[default]Mill/Recovery',",
    "\t'[default]Mill/GrindSize',",
    "]",
    "",
    "def shiftTotals(shift):",
    "\t\"\"\"Return the shift's totals as a dict, keyed by the tag's leaf name.\"\"\"",
    "\tvalues = system.tag.readBlocking(SHIFT_TAGS)",
    "\ttotals = {}",
    "\tfor path, qv in zip(SHIFT_TAGS, values):",
    "\t\ttotals[path.split('/')[-1]] = qv.value",
    "\tlogger = system.util.getLogger('Concentrator')",
    "\tlogger.infof('Shift %s totals: %s', shift, totals)",
    "\treturn totals",
    "",
    "def recoveryLoss(before, after):",
    "\treturn round(before - after, 2)",
    "",
])

TEST_SOURCE = "\n".join([
    "from metallurgy.shift_totals import recoveryLoss",
    "",
    "def setUp():",
    "\tglobal ORDERS",
    "\tORDERS = [{'qty': 4, 'price': 25.0}, {'qty': 1, 'price': 9.5}]",
    "",
    "def test_recovery_loss_is_rounded():",
    "\tassert recoveryLoss(91.234, 88.1) == 3.13",
    "",
    "def test_order_total():",
    "\ttotal = sum(o['qty'] * o['price'] for o in ORDERS)",
    "\tassert total == 109.5",
    "",
    "def test_discount_applies_over_a_hundred():",
    "\ttotal = sum(o['qty'] * o['price'] for o in ORDERS)",
    "\tassert total * 0.9 == 98.0, 'expected the 10% discount to land on 98.55'",
    "",
])


def api(page, method, url, csrf="", body=None):
    return page.evaluate(
        """async ([spa, method, url, csrf, body]) => {
             const headers = {'Accept': 'application/json'};
             if (csrf) headers['X-CSRF-Token'] = csrf;
             if (body !== null) headers['Content-Type'] = 'application/json';
             const res = await fetch(spa + url, {
               method, credentials: 'include', headers,
               body: body === null ? undefined : JSON.stringify(body)});
             return {status: res.status, text: await res.text()};
           }""",
        [SPA, method, url, csrf, body])


def q(value):
    return urllib.parse.quote(str(value))


def entry_for(page, path):
    scripts = json.loads(api(page, "GET", f"api/scripts?project={q(PROJECT)}")["text"])
    return next((e for e in scripts.get("scripts", []) if e.get("path") == path), None)


def write(page, csrf, path, source):
    found = entry_for(page, path)
    return page.evaluate(
        """async ([spa, url, csrf, source, ifMatch]) => {
             const headers = {'Accept': 'application/json',
                              'Content-Type': 'application/json',
                              'X-CSRF-Token': csrf};
             if (ifMatch) headers['If-Match'] = ifMatch;
             const res = await fetch(spa + url, {method: 'POST', credentials: 'include',
               headers, body: JSON.stringify({source})});
             return res.status;
           }""",
        [SPA, f"api/scripts/content/{urllib.parse.quote(path, safe='')}?project={q(PROJECT)}",
         csrf, source, (found or {}).get("signature")])


def remove_fixtures(page, csrf):
    for path in FIXTURES:
        found = entry_for(page, path)
        if not found:
            continue
        page.evaluate(
            """async ([spa, url, csrf, ifMatch]) => {
                 await fetch(spa + url, {method: 'DELETE', credentials: 'include',
                   headers: {'X-CSRF-Token': csrf, 'If-Match': ifMatch}});
               }""",
            [SPA, f"api/scripts/content/{urllib.parse.quote(path, safe='')}?project={q(PROJECT)}",
             csrf, found.get("signature") or ""])


def expand_tree(page):
    for _ in range(6):
        shut = page.locator('.file-tree [aria-expanded="false"]')
        if shut.count() == 0:
            return
        for i in range(shut.count()):
            try:
                shut.nth(i).click(timeout=1500)
            except Exception:
                pass
        page.wait_for_timeout(250)


def open_row(page, label):
    expand_tree(page)
    row = page.locator(
        f'.file-tree .file-tree-item:has(.file-tree-name:text-is("{label}"))')
    if row.count() == 0:
        row = page.locator('.file-tree .file-tree-item').filter(has_text=label)
    if row.count() == 0:
        return False
    row.first.click()
    page.wait_for_timeout(2500)
    return True


def shot(page, name, cut_above=None, cut_below=0):
    """Write one screenshot, optionally cropped to end above a selector.

    `cut_below` trims a fixed number of pixels off the bottom; `cut_above` ends
    the shot where a selector begins. The latter exists for the Problems panel. Its second section is what the
    GATEWAY has logged, which on a lab rig is dozens of "no audit profile
    configured" warnings carrying sha256 hashes and old fixture names. That is a
    real feature and it is not what this picture is about, so the shot ends
    where that list begins rather than showing it as though it were the point.
    """
    path = os.path.join(IMAGES, name)
    clip = None
    if cut_below:
        size = page.viewport_size
        clip = {"x": 0, "y": 0, "width": size["width"],
                "height": size["height"] - cut_below}
    if cut_above:
        try:
            box = page.locator(cut_above).first.bounding_box()
            if box and box["y"] > 200:
                size = page.viewport_size
                clip = {"x": 0, "y": 0, "width": size["width"], "height": int(box["y"]) - 8}
        except Exception:
            clip = None
    page.screenshot(path=path, clip=clip)
    print(f"  wrote {os.path.relpath(path, os.getcwd())}")


with sync_playwright() as p:
    browser = p.chromium.launch()
    # The width the README's images have always been taken at. Changing it makes
    # the new shots a different size from any that are not re-taken, which reads
    # on the page as one of them being wrong.
    context = browser.new_context(viewport={"width": 1600, "height": 1000},
                                  device_scale_factor=2)
    page = context.new_page()
    login(page)

    # ---------- the gateway's own navigation ----------
    page.goto(GATEWAY_URL + "/web/home", wait_until="load", timeout=30000)
    page.wait_for_timeout(4000)
    # A lab gateway runs on a two-hour trial, and an expired-trial banner across
    # the bottom of the page is not what this screenshot is about. Reset it if
    # the button is there; carry on if it is not, because a licensed gateway has
    # no button and that is the state we want anyway.
    try:
        reset = page.get_by_role("button", name="Reset Trial")
        if reset.count():
            reset.first.click()
            page.wait_for_timeout(3000)
            page.reload(wait_until="load", timeout=30000)
            page.wait_for_timeout(3000)
    except Exception as e:
        print(f"  (trial reset skipped: {e})")
    # The trial strip is pinned to the bottom of the gateway's own page. Even
    # reset it says "Trial Mode", which is a fact about this lab rig and not
    # about the module, so the shot stops above it.
    shot(page, "gateway-nav.png", cut_below=90)

    page.goto(GATEWAY_URL + SPA, wait_until="load", timeout=30000)
    page.wait_for_selector(".file-tree-header", timeout=20000)
    session = json.loads(page.evaluate(
        "async (spa) => JSON.stringify(await (await fetch(spa + 'api/auth/session',"
        " {credentials:'include'})).json())", SPA))
    csrf = session.get("csrfToken")

    page.select_option(".workspace-project select", PROJECT)
    page.wait_for_timeout(1500)
    write(page, csrf, SHOT_MODULE, DEMO_SOURCE)
    write(page, csrf, TEST_MODULE, TEST_SOURCE)
    page.reload(wait_until="load", timeout=30000)
    page.wait_for_selector(".file-tree-header", timeout=20000)
    page.select_option(".workspace-project select", PROJECT)
    page.wait_for_timeout(2000)

    # ---------- editing ----------
    open_row(page, "shift_totals")
    page.wait_for_timeout(2500)
    shot(page, "editor.png")

    # ---------- completions ----------
    editor = page.locator(".cm-content").first
    editor.click()
    page.keyboard.press("Control+End")
    page.keyboard.press("Enter")
    page.keyboard.type("system.tag.", delay=90)
    page.wait_for_timeout(2500)
    shot(page, "completion.png")
    page.keyboard.press("Escape")

    # ---------- a diagnostic ----------
    # Undo the completion typing FIRST, so the broken line is the only thing
    # wrong in the file. An earlier pass left a half-typed `system.tag.` above
    # it, and the shot then showed two markers with the caption explaining one.
    for _ in range(30):
        page.keyboard.press("Control+Z")
    page.wait_for_timeout(1200)
    page.keyboard.press("Control+End")
    page.keyboard.type("\n\ndef recoveryLoss(before after):\n\treturn before - after\n",
                       delay=55)
    # The squiggle, the gutter mark and the ruler entry all arrive on the
    # server's answer, not on the keystroke.
    page.wait_for_timeout(4500)
    # And the Problems panel, because a squiggle is a few pixels wide in a README
    # thumbnail while a row of text is readable.
    page.locator('.activity-item[aria-label="Problems"]').click()
    page.wait_for_timeout(2500)
    shot(page, "diagnostic.png", cut_above=".problems-runtime")

    # Drop the deliberate breakage rather than leaving it in the buffer: the
    # next shot is of a working editor.
    for _ in range(40):
        page.keyboard.press("Control+Z")
    page.wait_for_timeout(1500)

    # ---------- the Tests panel ----------
    page.locator('.activity-item[aria-label="Tests"]').click()
    page.wait_for_selector(".tests-panel", timeout=20000)
    page.wait_for_timeout(3000)
    if page.locator(".tests-panel-run").count():
        page.locator(".tests-panel-run").click()
        try:
            page.wait_for_selector(".tests-panel-tally", timeout=120000)
        except Exception:
            pass
        page.wait_for_timeout(1500)
        toggle = page.locator(".tests-row-toggle").first
        if toggle.count():
            toggle.click()
            page.wait_for_timeout(800)
    shot(page, "tests.png")

    # ---------- two scripts side by side ----------
    # The split is the answer to "I want to see two of these at once", and until
    # 1.18.0 the README had no picture of it — the compare view's shot occupied
    # the slot instead. A fresh page, so the two panes hold exactly the two
    # scripts being shown and not whatever the earlier shots left open.
    page.reload(wait_until="load", timeout=30000)
    page.wait_for_selector(".file-tree-header", timeout=20000)
    page.select_option(".workspace-project select", PROJECT)
    page.wait_for_timeout(2000)
    open_row(page, "shift_totals")
    open_row(page, "test_totals")
    page.locator(".tab-strip-action").first.click()
    page.wait_for_timeout(2500)
    shot(page, "split.png")

    # ---------- the Database Query Browser ----------
    # Against a real configured datasource, not the script fixtures above: the
    # Query Browser runs ad hoc SQL over whatever JDBC connection the gateway
    # has, so this shot means nothing without real rows on the other end.
    # Maximising the panel hides the (now irrelevant) code editor and gives the
    # schema tree, the SQL and the result grid the full height to be readable.
    page.locator('.activity-item[aria-label="Query"]').click()
    page.wait_for_selector(".qb-toolbar", timeout=20000)
    page.locator('.panel-icon-button[aria-label="Maximise panel"]').click()
    page.wait_for_timeout(500)
    page.select_option(".qb-toolbar select", QUERY_DATASOURCE)
    page.wait_for_selector(f'.qb-table-name:text-is("{QUERY_TABLE}")', timeout=15000)
    table_row = page.locator(f'.qb-node:has(.qb-table-name:text-is("{QUERY_TABLE}"))')
    table_row.locator(".qb-disclosure").click()
    page.wait_for_timeout(1500)
    qb_editor = page.locator(".qb-editor .cm-content")
    qb_editor.click()
    page.keyboard.press("Control+A")
    page.keyboard.type(QUERY_SQL, delay=15)
    page.wait_for_timeout(300)
    page.locator(".qb-toolbar button.primary").click()
    page.wait_for_selector(".qb-table", timeout=20000)
    page.wait_for_timeout(1000)
    shot(page, "query-browser.png")

    # ---------- clean up ----------
    page.reload(wait_until="load", timeout=30000)
    page.wait_for_selector(".file-tree-header", timeout=20000)
    page.select_option(".workspace-project select", PROJECT)
    page.wait_for_timeout(1500)
    remove_fixtures(page, csrf)
    left = [f for f in FIXTURES if entry_for(page, f)]
    print(f"  cleanup: {', '.join(left) if left else 'every fixture removed'}")
    browser.close()

print("\nScreenshots written. LOOK at them before committing — this script "
      "asserts nothing.")
