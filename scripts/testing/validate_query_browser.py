#!/usr/bin/env python3
"""Live validation of the Database Query Browser against a real datasource.

Every check below runs an authenticated fetch through the SAME Playwright
page `deploy_gate.py` logs in with (`gateway_session.login`), exactly the way
that file already proves the socket and route plumbing — a route that exists
but 401s for an unauthenticated caller would otherwise be indistinguishable
from one that is not mounted. See DbQueryRouteHandler's class Javadoc for the
contract every assertion here is checked against.

This suite creates the fixtures it destroys, and clears its own first: every
run drops `PREFIX + "scratch"` before creating it, so a suite killed mid-run
leaves nothing behind for the next one to trip over.

Usage:
    SI_GATEWAY_CONFIG=$PWD/config.local.json PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
      .venv/bin/python validate_query_browser.py
"""
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from gateway_session import CONFIG, GATEWAY_URL, login  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SPA_PATH = CONFIG.get("spa_path", "/data/scriptide/")
# SI_QB_DATASOURCE lets this suite run against a second (or third) datasource
# — e.g. MySQL_QB_Test, MSSQL_QB_Test — without touching the Postgres run at
# all — default unchanged.
DATASOURCE = os.environ.get("SI_QB_DATASOURCE", "Postgres_Test")
# The handful of statements that are genuinely vendor-specific (SLEEP, the
# session/process check, a wide-row generator, bytes/temporal literals) live
# in one dialect table keyed off this flag, so the rest of the suite — which
# is plain ANSI SQL against a scratch table — never needs to know which
# datasource it is talking to.
_ds_lower = DATASOURCE.strip().lower()
if _ds_lower.startswith("mysql"):
    DIALECT = "mysql"
elif _ds_lower.startswith("mssql"):
    DIALECT = "mssql"
else:
    DIALECT = "postgres"
PREFIX = "scriptide_qb_validate_"
# A token per PROCESS run, not a fixed name — two runs of this suite at once
# (or a run started before a previous one's fixtures were swept) must not
# collide on the same table name.
RUN_TOKEN = secrets.token_hex(4)
SCRATCH = f"{PREFIX}scratch_{RUN_TOKEN}"
CONTAINER = CONFIG.get("container_name")
POLICY_FILE = "/usr/local/bin/ignition/data/modules/scriptide/policy.properties"
PROJECTS_DIR = "/usr/local/bin/ignition/data/projects"
# The test gateway's web login authenticates against THIS internal user
# source (security-properties systemIdentityProvider="temp"), not "default" —
# confirmed live: "default" lists 8 unrelated demo accounts and no "admin" at
# all, while "temp" lists exactly one user, "admin", with the Administrator
# role. A temporary user created in the wrong source can never log in.
TEMP_USER_SOURCE = "temp"

# Stable (non-RUN_TOKEN) fixtures for MySQL/MSSQL: dropped and recreated at
# the start of every run, never mid-run — the UI section needs a table that
# is still there after SCRATCH has already been dropped, the same role
# oi_customer plays for Postgres_Test's own (pre-existing, not suite-owned)
# schema. On MSSQL these live in schema QB_SCHEMA (not dbo) — see
# setup_mssql_fixtures for why.
QB_TAB = "qb_tab"
QB_XTAB = "qbXtab"  # deliberately one character off QB_TAB, to prove '_' pattern-escaping
QB_VIEW = "qb_view"
QB_SCHEMA = "qb"  # MSSQL only — a deliberately non-dbo schema
# A second database, granted SELECT/read access to the same user, set up
# OUTSIDE this suite (it needs CREATE DATABASE, which the query-browser user
# does not and should not have) — see the module's testing notes. Only used
# to observe whether the schema tree scopes to the connected database.
QB_OTHER_DB = "scriptide_qb_other"
QB_OTHER_TABLE = "other_db_tab"

# The UI section needs one known table+column that (a) survives past the
# point SCRATCH is dropped and (b) filters to itself uniquely. Postgres_Test
# already has such a table in its real schema (oi_customer); MySQL_QB_Test and
# MSSQL_QB_Test are throwaway databases with nothing pre-existing, so they use
# the suite's own QB_TAB fixture instead — "qb_tab" does not match "qbXtab" as
# a substring, so the filter-narrows-the-tree check stays just as exact.
if DIALECT in ("mysql", "mssql"):
    UI_TABLE, UI_COLUMN, UI_FILTER = QB_TAB, "label", "qb_tab"
else:
    UI_TABLE, UI_COLUMN, UI_FILTER = "oi_customer", "customer_code", "oi_cust"
# 1.29.0 schema-qualifies the tree/insert for a table outside the default
# schema — on MSSQL, QB_TAB lives in QB_SCHEMA (not dbo), so the tree shows
# and inserts "qb.qb_tab", not the bare name. MySQL has no second schema in
# play here (QB_TAB is in the connected database itself), so it stays bare.
UI_TABLE_QUALIFIED = f"{QB_SCHEMA}.{UI_TABLE}" if DIALECT == "mssql" else UI_TABLE


def sleep_sql(seconds):
    if DIALECT == "mysql":
        return f"SELECT SLEEP({seconds})"
    if DIALECT == "mssql":
        return f"WAITFOR DELAY '00:{seconds // 60:02d}:{seconds % 60:02d}'"
    return f"SELECT pg_sleep({seconds})"


def active_sleep_count_sql():
    """How many OTHER sessions are still inside the sleep call right now."""
    if DIALECT == "mysql":
        return ("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST "
                "WHERE INFO LIKE '%SLEEP%' AND ID <> CONNECTION_ID()")
    if DIALECT == "mssql":
        return ("SELECT COUNT(*) AS n FROM sys.dm_exec_requests r "
                "CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t "
                "WHERE t.text LIKE '%WAITFOR%' AND r.session_id <> @@SPID")
    return ("SELECT count(*) AS n FROM pg_stat_activity "
            "WHERE query ILIKE '%pg_sleep%' AND state = 'active' AND pid <> pg_backend_pid()")


def open_txn_count_sql():
    """Sessions genuinely sitting inside an open transaction right now."""
    if DIALECT == "mysql":
        # MySQL's PROCESSLIST has no "idle in transaction" state string —
        # INNODB_TRX lists exactly the transactions actually open, which is a
        # more direct answer to the same question.
        return "SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX"
    if DIALECT == "mssql":
        # Scoped to OUR login: sys.dm_tran_active_transactions also counts
        # SQL Server's own internal/system transactions (version store,
        # checkpoint, ...), which are always nonzero and unrelated to this
        # suite's own connections.
        return ("SELECT COUNT(*) AS n FROM sys.dm_tran_session_transactions t "
                "JOIN sys.dm_exec_sessions s ON t.session_id = s.session_id "
                "WHERE s.login_name = 'scriptide_qb'")
    return ("SELECT count(*) AS n FROM pg_stat_activity "
            "WHERE state = 'idle in transaction' AND pid <> pg_backend_pid()")


def now_ts_sql():
    if DIALECT == "mysql":
        return "SELECT NOW(3) AS ts"
    if DIALECT == "mssql":
        return "SELECT SYSDATETIME() AS ts"
    return "SELECT now()::timestamp AS ts"


def bytes4_sql():
    """A 4-byte binary value — bytea on Postgres, VARBINARY/BLOB on MySQL/MSSQL."""
    if DIALECT == "mysql":
        return "SELECT CAST(x'deadbeef' AS BINARY(4)) AS b"
    if DIALECT == "mssql":
        return "SELECT CAST(0xDEADBEEF AS VARBINARY(4)) AS b"
    return "SELECT '\\xdeadbeef'::bytea AS b"


def big_series_sql(n):
    """n rows numbered 1..n, no session state and no recursion-depth limit to
    raise — generate_series on Postgres, GENERATE_SERIES (built in since SQL
    Server 2022) on MSSQL, a fixed cross join of 10x5 on MySQL (100,000 rows,
    LIMIT applied) since MySQL has neither generate_series nor an unbounded
    default recursive-CTE depth."""
    if DIALECT == "mysql":
        digit = "(SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 " \
                "UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9)"
        return (f"SELECT (t4.n*10000 + t3.n*1000 + t2.n*100 + t1.n*10 + t0.n + 1) AS n "
                f"FROM {digit} t0, {digit} t1, {digit} t2, {digit} t3, {digit} t4 LIMIT {n}")
    if DIALECT == "mssql":
        return f"SELECT value AS n FROM GENERATE_SERIES(1, {n})"
    return f"SELECT generate_series(1, {n}) AS n"


def ten_rows_insert_sql(table):
    if DIALECT == "mysql":
        ten = " UNION SELECT ".join(str(i) for i in range(1, 11))
        return f"INSERT INTO {table} SELECT n, CONCAT('r', n), '' FROM (SELECT {ten}) x(n)"
    if DIALECT == "mssql":
        return f"INSERT INTO {table} SELECT value, CONCAT('r', value), '' FROM GENERATE_SERIES(1, 10)"
    return f"INSERT INTO {table} SELECT n, 'r'||n, '' FROM generate_series(1, 10) n"


def scratch_sweep_sql(prefix):
    if DIALECT == "mysql":
        return (f"SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() "
                f"AND table_name LIKE '{prefix}scratch\\_%'")
    if DIALECT == "mssql":
        # sys.objects, as this module's own testing notes call for, restricted
        # to type='U' (user table) so the sweep can't pick up a view/procedure
        # that happens to match the same LIKE pattern.
        return (f"SELECT name FROM sys.objects WHERE type = 'U' "
                f"AND name LIKE '{prefix}scratch\\_%' ESCAPE '\\'")
    return (f"SELECT tablename FROM pg_tables WHERE tablename LIKE '{prefix}scratch\\_%' "
            "AND schemaname = 'public'")


def begin_tran_sql():
    """The bare 'start a transaction' keyword — 'BEGIN' on Postgres, 'BEGIN
    TRAN' on MSSQL. Both accept it as the first statement of an ordinary
    multi-statement batch with no special connection property required,
    unlike MySQL (see the multi-statement checks)."""
    return "BEGIN TRAN" if DIALECT == "mssql" else "BEGIN"


results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    label = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
    print(f"  [{label}] {name}" + (f": {detail}" if detail else ""))


def api(path):
    return SPA_PATH.rstrip("/") + path


# The one fetch helper every check below is built on. Mirrors deploy_gate.py's
# own inline evaluate() calls rather than introducing a second HTTP client
# with a separate cookie jar — the whole point is the SAME session.
FETCH_JS = """
async ({ path, method, body, csrf, spa, extraHeaders }) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(extraHeaders || {}) };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const init = { method, credentials: 'include', headers };
  if (body !== null) init.body = JSON.stringify(body);
  const r = await fetch(spa + path.replace(/^\\//, ''), init);
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, json, text };
}
"""


def call(page, path, method="GET", body=None, csrf=None, extra_headers=None):
    return page.evaluate(FETCH_JS, {
        "path": path, "method": method, "body": body, "csrf": csrf, "spa": SPA_PATH,
        "extraHeaders": extra_headers,
    })


def run_sql(page, csrf, sql, run_id=None, max_rows=None, project=None, read_only=None):
    b = {"runId": run_id or f"validate-{time.time_ns()}", "datasource": DATASOURCE, "sql": sql}
    if max_rows is not None:
        b["maxRows"] = max_rows
    if project is not None:
        b["project"] = project
    if read_only is not None:
        b["readOnly"] = read_only
    return call(page, "api/db-queries/run", "POST", b, csrf)


def cleanup(page, csrf):
    """Drop this run's own scratch table, and sweep any tables a KILLED earlier
    run left behind under the same prefix (each run's table name is now
    unique — see RUN_TOKEN — so an old leftover has a different suffix and
    would not otherwise be found by name). Never fails the suite."""
    run_sql(page, csrf, f"DROP TABLE IF EXISTS {SCRATCH}")
    sweep = run_sql(page, csrf, scratch_sweep_sql(PREFIX))
    rows = ((sweep.get("json") or {}).get("results") or [{}])[0].get("rows", [])
    for row in rows:
        name = row[0]
        if name != SCRATCH:
            run_sql(page, csrf, f"DROP TABLE IF EXISTS {name}")


def setup_mysql_fixtures(page, csrf):
    """MySQL-only schema-tree/UI fixtures. Dropped and recreated here, at the
    START of the run (this suite's own 'creates what it destroys, and clears
    its own first' rule) — QB_TAB is used by both the schema-tree checks and
    the UI section, well after SCRATCH has already been dropped, so it cannot
    be RUN_TOKEN-suffixed the way SCRATCH is."""
    run_sql(page, csrf, f"DROP VIEW IF EXISTS {QB_VIEW}")
    run_sql(page, csrf, f"DROP TABLE IF EXISTS {QB_XTAB}")
    run_sql(page, csrf, f"DROP TABLE IF EXISTS {QB_TAB}")
    run_sql(page, csrf, f"CREATE TABLE {QB_TAB} (id INT PRIMARY KEY, label VARCHAR(50))")
    run_sql(page, csrf, f"INSERT INTO {QB_TAB} VALUES (1,'alpha'),(2,'beta')")
    run_sql(page, csrf, f"CREATE TABLE {QB_XTAB} (id INT PRIMARY KEY, other_col VARCHAR(50))")
    run_sql(page, csrf, f"INSERT INTO {QB_XTAB} VALUES (1,'zzz')")
    run_sql(page, csrf, f"CREATE VIEW {QB_VIEW} AS SELECT id, label FROM {QB_TAB}")


def setup_mssql_fixtures(page, csrf):
    """MSSQL-only schema-tree/UI fixtures — deliberately in schema QB_SCHEMA,
    not dbo: this is what lets the same run also answer "how does a non-dbo
    table show in the tree, and does double-click's unqualified SELECT *
    actually work against it" (it can't — see the double-click-runs check)."""
    run_sql(page, csrf, f"DROP VIEW IF EXISTS {QB_SCHEMA}.{QB_VIEW}")
    run_sql(page, csrf, f"DROP TABLE IF EXISTS {QB_SCHEMA}.{QB_XTAB}")
    run_sql(page, csrf, f"DROP TABLE IF EXISTS {QB_SCHEMA}.{QB_TAB}")
    run_sql(page, csrf, f"DROP SCHEMA IF EXISTS {QB_SCHEMA}")
    run_sql(page, csrf, f"CREATE SCHEMA {QB_SCHEMA}")
    run_sql(page, csrf, f"CREATE TABLE {QB_SCHEMA}.{QB_TAB} (id INT PRIMARY KEY, label VARCHAR(50))")
    run_sql(page, csrf, f"INSERT INTO {QB_SCHEMA}.{QB_TAB} VALUES (1,'alpha'),(2,'beta')")
    run_sql(page, csrf, f"CREATE TABLE {QB_SCHEMA}.{QB_XTAB} (id INT PRIMARY KEY, other_col VARCHAR(50))")
    run_sql(page, csrf, f"INSERT INTO {QB_SCHEMA}.{QB_XTAB} VALUES (1,'zzz')")
    run_sql(page, csrf, f"CREATE VIEW {QB_SCHEMA}.{QB_VIEW} AS SELECT id, label FROM {QB_SCHEMA}.{QB_TAB}")


# ==================== "temp" user-source admin helpers ====================
# Driving the modern Gateway config UI's Users & Roles panel — no REST API
# exists for this, so it is Playwright end to end. Selectors were confirmed
# live on this gateway 28/09/2026, not guessed: the DOM uses `data-label` on
# each show-more menu item and clean input ids on the create-user form.

def _open_manage_users(page, source_name):
    page.goto(GATEWAY_URL + "/app/platform/security/user-sources", wait_until="load", timeout=30000)
    page.wait_for_timeout(1200)
    row = page.locator(".ia-data-grid-row").filter(has=page.locator(f"text=/^{source_name}$/"))
    row.get_by_label("show-more-button").click()
    page.wait_for_timeout(400)
    page.locator("li[data-label='Manage Users']").click()
    page.wait_for_timeout(1200)


def create_temp_user(page, username, password):
    """Create a user in TEMP_USER_SOURCE with no role. `page` must already be
    an authenticated admin session. Never prints or stores the password."""
    _open_manage_users(page, TEMP_USER_SOURCE)
    page.get_by_role("button", name="Create User", exact=True).click()
    page.wait_for_timeout(800)
    page.fill("#username-input", username)
    page.fill("#password-input", password)
    page.fill("#confirm-password-input", password)
    # Two "Create User" buttons are on screen at this point: the drawer
    # toolbar's (opened the form) and this one (submits it) — `.last`.
    page.get_by_role("button", name="Create User", exact=True).last.click()
    page.wait_for_timeout(1200)


def make_temp_user_admin(page, username):
    """Grant the Administrator role to a user already created by create_temp_user."""
    _open_manage_users(page, TEMP_USER_SOURCE)
    user_row = page.locator(".ia-data-grid-row").filter(has=page.locator(f"text=/^{username}$/"))
    user_row.get_by_label("show-more-button").click()
    page.wait_for_timeout(400)
    page.locator("li[data-label='Assign Roles']").click()
    page.wait_for_timeout(800)
    # Scoped to the roles-picker panel: the background grid also shows the
    # word "Administrator" as another row's role, a second match for a bare
    # text locator.
    page.locator("#groups-input-group").get_by_text("Administrator", exact=True).click()
    page.wait_for_timeout(200)
    page.get_by_role("button", name="Save Changes", exact=True).click()
    page.wait_for_timeout(1000)


def delete_temp_user(page, username):
    """Remove a user created by create_temp_user. Safe to call even if it was
    never created or was already removed — used from a finally block."""
    try:
        _open_manage_users(page, TEMP_USER_SOURCE)
        user_row = page.locator(".ia-data-grid-row").filter(has=page.locator(f"text=/^{username}$/"))
        if user_row.count() == 0:
            return
        user_row.get_by_label("show-more-button").click()
        page.wait_for_timeout(400)
        page.locator("li[data-label='Delete']").click()
        page.wait_for_timeout(600)
        confirm = page.get_by_role("button", name="Delete", exact=True)
        if confirm.count() > 0:
            confirm.last.click()
            page.wait_for_timeout(800)
    except Exception as e:  # noqa: BLE001 - best-effort cleanup, never hide the real failure
        print(f"  (cleanup warning: could not delete temp user {username}: {e})")


def set_editor_text(page, text):
    """Replace the Query Browser's whole SQL buffer via real keyboard input —
    the same CodeMirror pattern capture_readme_shots.py already uses."""
    page.click(".qb-editor .cm-content")
    page.keyboard.press("Control+a")
    page.keyboard.press("Delete")
    if text:
        page.keyboard.type(text)


def refresh_tree(page, expect_name):
    """Click Refresh tables and wait for a table created since the tree loaded.
    Tables made through the API skip the browser's own post-run refresh, and
    the gateway caches the list for five minutes."""
    page.get_by_role("button", name="Refresh tables").click()
    try:
        page.locator(".qb-table-name", has_text=expect_name).first.wait_for(timeout=15000)
        return True
    except Exception:
        return False


def editor_text(page):
    return page.locator(".qb-editor .cm-content").inner_text()


def wait_for_run_to_finish(page, selector=".qb-toolbar button.primary", timeout=20000):
    """Wait for a toolbar's Run button (Query Browser's by default; pass
    `.console-toolbar button.primary` for the console — same busy-text
    pattern) to return to its idle, enabled state — proof a run actually
    finished (success or failure) — rather than a fixed sleep guessing how
    long it takes. Immune to stale content from an EARLIER run still on
    screen (unlike waiting on `.qb-table`/`.qb-error` directly): the button's
    own busy state is per-run regardless of what the previous result
    looked like.

    Call this right after clicking Run. The 50ms floor is not a guess at
    query time — it only covers the gap between the click's own React state
    update and the DOM actually painting `disabled`, so the real wait below
    does not race that paint and return before the run even started; the
    run itself, however long, is awaited properly by the selector below."""
    page.wait_for_timeout(50)
    page.wait_for_selector(f"{selector}:not([disabled])", timeout=timeout)


def login_as(page, username, password):
    """Log a fresh page/context in as a specific user — the same IdP flow
    gateway_session.login() drives for the admin config, generalised for an
    arbitrary username/password pair."""
    page.goto(GATEWAY_URL + "/data/app/login", wait_until="load", timeout=30000)
    page.wait_for_timeout(500)
    page.get_by_role("textbox").first.fill(username)
    page.get_by_text("CONTINUE", exact=True).click()
    page.wait_for_timeout(800)
    page.locator("input[type='password']").first.fill(password)
    page.get_by_text("CONTINUE", exact=True).click()
    page.wait_for_timeout(1500)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        # clipboard-read/write granted up front for whatever this is worth on
        # an HTTPS gateway — on THIS one it changes nothing: plain HTTP means
        # window.isSecureContext is false, so navigator.clipboard is undefined
        # outright rather than present-but-refusing, and no permission grant
        # makes it exist. See the Copy-as-TSV check below for how this is
        # actually verified here.
        context = browser.new_context(
            viewport={"width": 1600, "height": 1000},
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = context.new_page()
        login(page)
        page.goto(GATEWAY_URL + SPA_PATH, wait_until="load", timeout=30000)
        session = page.evaluate(
            "async (spa) => { const r = await fetch(spa + 'api/auth/session',"
            " {credentials: 'include'}); return await r.json(); }", SPA_PATH,
        )
        if not session.get("authenticated") or not session.get("csrfToken"):
            sys.exit(f"FAIL: not authenticated ({session}) — fix login before trusting anything below")
        csrf = session["csrfToken"]
        print(f"Validating the Query Browser against {DATASOURCE} on {GATEWAY_URL}, as {session.get('username')}")

        cleanup(page, csrf)
        if DIALECT == "mysql":
            setup_mysql_fixtures(page, csrf)
        elif DIALECT == "mssql":
            setup_mssql_fixtures(page, csrf)

        # ==================== A: schema-qualified names (1.29.0) ====================
        # Deliberately BEFORE anything else touches this datasource's tables —
        # SdkDbSchema's tablesDetailedNow cache has a 300 s TTL keyed only on
        # the datasource name, so a check running even a few minutes later
        # (well within one run of this suite, which has several deliberate
        # waits well past 300 s in total) would see a STALE snapshot from
        # before this schema existed rather than a fresh one. Being first
        # means the first-ever read of this run already includes it.
        NEW_SCHEMA = f"qb_s_{RUN_TOKEN}"
        # B's own mixed-case completion check (below) needs a DEFAULT-schema
        # mixed-case table — created here, for the SAME cache-freshness
        # reason as NEW_SCHEMA above, even though B itself runs much later.
        # `scratch_` in the name matches cleanup()'s own sweep pattern, so a
        # run killed before reaching its drop (in the B section) still gets
        # it cleared by the NEXT run's cleanup() at the top of main().
        MIXED_TABLE = f"{PREFIX}scratch_MixedCase_{RUN_TOKEN}"
        if DIALECT == "postgres":
            run_sql(page, csrf, f'DROP TABLE IF EXISTS "{MIXED_TABLE}"')
            run_sql(page, csrf, f'CREATE TABLE "{MIXED_TABLE}" (id int)')
            run_sql(page, csrf, f"DROP SCHEMA IF EXISTS {NEW_SCHEMA} CASCADE")
            run_sql(page, csrf, f"CREATE SCHEMA {NEW_SCHEMA}")
            run_sql(page, csrf, f"CREATE TABLE {NEW_SCHEMA}.t1 (id int, label text)")
            run_sql(page, csrf, f'CREATE TABLE {NEW_SCHEMA}."MixedCase" (id int)')
            try:
                # fresh=1: the tables were created a moment ago, and the gateway's
                # schema cache may already hold this datasource's list.
                tabs = call(page, "api/db-queries/tables?fresh=1&datasource=" + DATASOURCE)
                rows = (tabs["json"] or {}).get("tables", [])
                seen_pairs = {(r.get("schema"), r["name"]) for r in rows}
                record("A: tables route reports the scratch schema's tables with schema+type",
                       (NEW_SCHEMA, "t1") in seen_pairs and (NEW_SCHEMA, "MixedCase") in seen_pairs,
                       f"schemas seen: {sorted({r.get('schema') for r in rows})}")
                record("A: connection facts (defaultSchema/identifierQuote/case-folding) are reported",
                       tabs["json"].get("identifierQuote") == '"' and tabs["json"].get("defaultSchema"),
                       json.dumps({k: tabs["json"].get(k) for k in (
                           "defaultSchema", "identifierQuote",
                           "storesLowerCaseIdentifiers", "storesUpperCaseIdentifiers")}))

                page.goto(GATEWAY_URL + SPA_PATH + "?view=query&project=Template",
                          wait_until="load", timeout=30000)
                page.get_by_label("Datasource").select_option(DATASOURCE)
                page.wait_for_selector(".qb-schema-group-name", timeout=15000)
                group_names = page.locator(".qb-schema-group-name").all_inner_texts()
                # .qb-schema-group-name is CSS text-transform: uppercase, so
                # innerText comes back upper-cased even though the underlying
                # DOM text (and the schema name itself) is not.
                record("A: the tree groups tables under a schema heading once several schemas exist",
                       any(NEW_SCHEMA.upper() in g.upper() for g in group_names), group_names)

                set_editor_text(page, "")
                page.locator(".qb-table-name", has_text=f"{NEW_SCHEMA}.t1").dblclick()
                qualified_ran_ok = editor_text(page).strip() == f"SELECT * FROM {NEW_SCHEMA}.t1"
                record("A: a table outside the default schema is shown and inserted schema-qualified",
                       qualified_ran_ok, editor_text(page))
                page.click(".qb-toolbar button.primary")
                wait_for_run_to_finish(page)
                record("A: the qualified insert actually RUNS (a result table, not an error)",
                       page.locator(".qb-table").count() > 0 and page.locator(".qb-error").count() == 0, "")

                set_editor_text(page, "")
                page.locator(".qb-table-name", has_text=f'{NEW_SCHEMA}."MixedCase"').dblclick()
                expected_mixed = f'SELECT * FROM {NEW_SCHEMA}."MixedCase"'
                record("A: a mixed-case name is quoted only where it needs to be",
                       editor_text(page).strip() == expected_mixed, editor_text(page))
                page.click(".qb-toolbar button.primary")
                wait_for_run_to_finish(page)
                record("A: the quoted mixed-case insert actually RUNS (a result table, not an error)",
                       page.locator(".qb-table").count() > 0 and page.locator(".qb-error").count() == 0, "")
            finally:
                run_sql(page, csrf, f"DROP SCHEMA IF EXISTS {NEW_SCHEMA} CASCADE")
        elif DIALECT == "mysql":
            # MySQL has no second "schema" to qualify against within one
            # connected database — "no schema qualification" per the module's
            # own testing notes. What DOES vary is quoting: a reserved word
            # needs backticks, an ordinary mixed-case name does not (MySQL's
            # table-name case rules are not the quoting trigger the way
            # Postgres's case-folding is).
            MIXED_A = f"MixedCase_{RUN_TOKEN}"
            RESERVED_A = "order"  # a genuine MySQL reserved word
            try:
                run_sql(page, csrf, f"DROP TABLE IF EXISTS `{MIXED_A}`")
                run_sql(page, csrf, f"CREATE TABLE `{MIXED_A}` (id int)")
                run_sql(page, csrf, f"DROP TABLE IF EXISTS `{RESERVED_A}`")
                run_sql(page, csrf, f"CREATE TABLE `{RESERVED_A}` (id int)")

                page.goto(GATEWAY_URL + SPA_PATH + "?view=query&project=Template",
                          wait_until="load", timeout=30000)
                page.get_by_label("Datasource").select_option(DATASOURCE)
                page.wait_for_selector(".qb-table-name", timeout=15000)
                record("A: Refresh tables shows tables created since the tree loaded",
                       refresh_tree(page, MIXED_A), MIXED_A)

                set_editor_text(page, "")
                page.locator(".qb-table-name", has_text=MIXED_A).first.dblclick()
                record("A: MySQL does not quote an ordinary mixed-case table name (no schema to qualify either)",
                       editor_text(page).strip() == f"SELECT * FROM {MIXED_A}", editor_text(page))
                page.click(".qb-toolbar button.primary")
                wait_for_run_to_finish(page)
                record("A: the unquoted mixed-case insert actually RUNS",
                       page.locator(".qb-table").count() > 0 and page.locator(".qb-error").count() == 0, "")

                page.fill(".qb-filter", "")
                set_editor_text(page, "")
                page.locator(".qb-table-name", has_text=RESERVED_A).first.dblclick()
                record("A: MySQL backtick-quotes a reserved-word table name on insert",
                       editor_text(page).strip() == f"SELECT * FROM `{RESERVED_A}`", editor_text(page))
                page.click(".qb-toolbar button.primary")
                wait_for_run_to_finish(page)
                record("A: the backtick-quoted reserved-word insert actually RUNS",
                       page.locator(".qb-table").count() > 0 and page.locator(".qb-error").count() == 0, "")
            finally:
                run_sql(page, csrf, f"DROP TABLE IF EXISTS `{MIXED_A}`")
                run_sql(page, csrf, f"DROP TABLE IF EXISTS `{RESERVED_A}`")
        elif DIALECT == "mssql":
            # QB_TAB already lives in QB_SCHEMA (not dbo) via setup_mssql_fixtures
            # — reused here as MSSQL's "outside the default schema" case. A
            # mixed-case DBO table needs no quoting at all: this rig's default
            # collation is case-insensitive, so there is no ambiguity to guard
            # against the way Postgres's case-folding creates one. A reserved
            # word DOES need quoting, with MSSQL's own identifierQuote (").
            MIXED_A = f"MixedCase_{RUN_TOKEN}"
            RESERVED_A = "order"
            try:
                run_sql(page, csrf, f"DROP TABLE IF EXISTS dbo.[{MIXED_A}]")
                run_sql(page, csrf, f"CREATE TABLE dbo.[{MIXED_A}] (id int)")
                run_sql(page, csrf, f'DROP TABLE IF EXISTS dbo."{RESERVED_A}"')
                run_sql(page, csrf, f'CREATE TABLE dbo."{RESERVED_A}" (id int)')

                page.goto(GATEWAY_URL + SPA_PATH + "?view=query&project=Template",
                          wait_until="load", timeout=30000)
                page.get_by_label("Datasource").select_option(DATASOURCE)
                page.wait_for_selector(".qb-table-name", timeout=15000)
                record("A: Refresh tables shows tables created since the tree loaded",
                       refresh_tree(page, MIXED_A), MIXED_A)

                set_editor_text(page, "")
                page.locator(".qb-table-name", has_text=UI_TABLE_QUALIFIED).first.dblclick()
                record("A: a table outside dbo (qb.qb_tab) is inserted schema-qualified",
                       editor_text(page).strip() == f"SELECT * FROM {UI_TABLE_QUALIFIED}", editor_text(page))
                page.click(".qb-toolbar button.primary")
                wait_for_run_to_finish(page)
                record("A: the schema-qualified insert actually RUNS",
                       page.locator(".qb-table").count() > 0 and page.locator(".qb-error").count() == 0, "")

                set_editor_text(page, "")
                page.locator(".qb-table-name", has_text=MIXED_A).first.dblclick()
                record("A: MSSQL does not quote a mixed-case dbo table (case-insensitive collation)",
                       editor_text(page).strip() == f"SELECT * FROM {MIXED_A}", editor_text(page))
                page.click(".qb-toolbar button.primary")
                wait_for_run_to_finish(page)
                record("A: the unquoted mixed-case insert actually RUNS",
                       page.locator(".qb-table").count() > 0 and page.locator(".qb-error").count() == 0, "")

                set_editor_text(page, "")
                page.locator(".qb-table-name", has_text=f'"{RESERVED_A}"').first.dblclick()
                record("A: MSSQL double-quotes a reserved-word table name on insert",
                       editor_text(page).strip() == f'SELECT * FROM "{RESERVED_A}"', editor_text(page))
                page.click(".qb-toolbar button.primary")
                wait_for_run_to_finish(page)
                record("A: the quoted reserved-word insert actually RUNS",
                       page.locator(".qb-table").count() > 0 and page.locator(".qb-error").count() == 0, "")
            finally:
                run_sql(page, csrf, f"DROP TABLE IF EXISTS dbo.[{MIXED_A}]")
                run_sql(page, csrf, f'DROP TABLE IF EXISTS dbo."{RESERVED_A}"')
        else:
            record("A: schema-qualified tree / qualified insert (Postgres-specific CREATE SCHEMA probe)",
                   None, f"SKIPPED on {DIALECT} — this batch's live A checks are Postgres_Test-specific")

        # ==================== Results ====================

        r = run_sql(page, csrf, f"CREATE TABLE {SCRATCH} (id int, name text, note text)")
        record("DDL: CREATE TABLE", r["json"] and r["json"].get("ok") is True
               and r["json"]["results"][0].get("affected") == 0,
               json.dumps(r["json"]))

        r = run_sql(page, csrf, f"SELECT * FROM {SCRATCH} WHERE 1=0")
        ok = (r["json"] or {}).get("ok") is True
        res0 = ok and r["json"]["results"][0]
        record("SELECT with 0 rows still returns columns", bool(res0)
               and res0["rowCount"] == 0 and len(res0["columns"]) == 3,
               json.dumps(r["json"]))

        r = run_sql(page, csrf, f"INSERT INTO {SCRATCH} VALUES (1, NULL, 'a'), (2, 'x', NULL)")
        record("INSERT affected count", (r["json"] or {}).get("ok") is True
               and r["json"]["results"][0].get("affected") == 2, json.dumps(r["json"]))

        r = run_sql(page, csrf, f"SELECT id, name, note FROM {SCRATCH} ORDER BY id")
        rows = ((r["json"] or {}).get("results") or [{}])[0].get("rows")
        record("NULL round-trips as JSON null, not the string \"None\"/\"null\"",
               rows == [[1, None, "a"], [2, "x", None]], json.dumps(rows))

        r = run_sql(page, csrf, f"UPDATE {SCRATCH} SET note = 'updated' WHERE id = 1")
        record("UPDATE affected count", (r["json"] or {}).get("ok") is True
               and r["json"]["results"][0].get("affected") == 1, json.dumps(r["json"]))

        r = run_sql(page, csrf, f"DELETE FROM {SCRATCH} WHERE id = 2")
        record("DELETE affected count", (r["json"] or {}).get("ok") is True
               and r["json"]["results"][0].get("affected") == 1, json.dumps(r["json"]))

        r = run_sql(page, csrf, now_ts_sql())
        val = ((r["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
        # A timestamp with no zone in its type (Postgres timestamp, SQL Server
        # DATETIME2, MySQL DATETIME) is wall-clock time: ISO with no "Z",
        # whichever driver returns it (Web IDE 1.27.5).
        record("a timestamp without a zone renders as wall-clock ISO, no 'Z'",
               isinstance(val, str) and "T" in val and not val.endswith("Z"), val)
        if DIALECT == "postgres":
            r = run_sql(page, csrf, "SELECT TIMESTAMPTZ '2026-09-29 13:45:30.25+10' AS tz")
            tz = ((r["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
            record("timestamptz renders as the UTC instant, with 'Z'",
                   tz == "2026-09-29T03:45:30.250Z", tz)

        # A bigint literal past 2^53 (JS's safe-integer ceiling) AND a numeric
        # with >15 significant digits, checked against the RAW response TEXT —
        # not the parsed json — because Python's json module would silently
        # round-trip a float through IEEE 754 exactly the way a browser does,
        # which is the one thing this check must not paper over.
        if DIALECT == "mssql":
            num_expr = "CAST(9007199254740993 AS BIGINT) AS big, CAST(123456789012345.678901234 AS DECIMAL(38,9)) AS num"
        elif DIALECT == "mysql":
            num_expr = "9007199254740993 AS big, CAST(123456789012345.678901234 AS DECIMAL(38,9)) AS num"
        else:
            num_expr = "9007199254740993 AS big, 123456789012345.678901234::numeric AS num"
        r = run_sql(page, csrf, f"SELECT {num_expr}")
        record("bigint beyond 2^53 keeps its exact digits in the wire JSON",
               "9007199254740993" in r["text"], r["text"][:300])
        record("numeric with >15 significant digits keeps its exact digits in the wire JSON",
               "123456789012345.678901234" in r["text"], r["text"][:300])

        r = run_sql(page, csrf, bytes4_sql())
        val = ((r["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
        record("bytea/binary becomes \"<n bytes>\", never raw bytes", val == "4 bytes", val)

        if DIALECT == "mysql":
            unicode_sql = "SELECT 'héllo wörld 日本語 🎉' AS u"
        elif DIALECT == "mssql":
            unicode_sql = "SELECT N'héllo wörld 日本語 🎉' AS u"  # NVARCHAR literal prefix
        else:
            unicode_sql = "SELECT 'héllo wörld 日本語 🎉'::text AS u"
        r = run_sql(page, csrf, unicode_sql)
        val = ((r["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
        record("Unicode text round-trips exactly, including emoji", val == "héllo wörld 日本語 🎉", val)

        limit_one = f"SELECT TOP 1 id AS the_id FROM {SCRATCH}" if DIALECT == "mssql" \
            else f"SELECT id AS the_id FROM {SCRATCH} LIMIT 1"
        r = run_sql(page, csrf, limit_one)
        cols = ((r["json"] or {}).get("results") or [{}])[0].get("columns")
        record("column alias is the reported column name",
               bool(cols) and cols[0]["name"] == "the_id", json.dumps(cols))

        r = run_sql(page, csrf, f"WITH t AS (SELECT id FROM {SCRATCH}) SELECT count(*) AS n FROM t")
        record("a CTE (WITH ...) runs as an ordinary SELECT",
               (r["json"] or {}).get("ok") is True, json.dumps(r["json"]))

        r = run_sql(page, csrf, f"SELECT id FROM {SCRATCH}; UPDATE {SCRATCH} SET note = note;")
        if DIALECT in ("postgres", "mssql"):
            results_list = (r["json"] or {}).get("results")
            record("two statements in one run produce two results, SELECT then UPDATE",
                   bool(results_list) and len(results_list) == 2
                   and "rows" in results_list[0] and "affected" in results_list[1],
                   json.dumps(results_list))
        else:
            # MySQL's simple query protocol needs allowMultiQueries=true on the
            # connection URL to accept a ';'-separated batch at all — WITHOUT
            # it (this datasource's default config) the whole batch is one
            # clear SQL error, not a partial run and not a crash/500.
            err = (r["json"] or {}).get("error") or {}
            record("a ';'-separated batch without allowMultiQueries fails as one clear SQL error",
                   (r["json"] or {}).get("ok") is False and "SQLState" in err.get("message", ""),
                   json.dumps(r["json"]))
            record("multi-statement WITH allowMultiQueries=true (two results, SELECT then UPDATE)",
                   None, "SKIPPED in this automated run — proving it needs a second connect URL on "
                         "the SAME named datasource; verified separately by toggling "
                         "allowMultiQueries=true on MySQL_QB_Test, running the identical batch, and "
                         "reverting — see the report for that evidence")

        r = run_sql(page, csrf, big_series_sql(20000), max_rows=999999)
        res = ((r["json"] or {}).get("results") or [{}])[0]
        record("maxRows above the 10000 hard ceiling is clamped, not honoured",
               res.get("rowCount") == 10000 and res.get("truncatedAt") == 10000, json.dumps(res)[:200])

        r = run_sql(page, csrf, f"DELETE FROM {SCRATCH}")
        r = run_sql(page, csrf, ten_rows_insert_sql(SCRATCH))
        r = run_sql(page, csrf, f"SELECT * FROM {SCRATCH}", max_rows=5)
        res = ((r["json"] or {}).get("results") or [{}])[0]
        record("truncation at a small maxRows reports truncatedAt and caps rows returned",
               res.get("rowCount") == 5 and res.get("truncatedAt") == 5, json.dumps(res)[:200])

        # M4: a statement that leaves a transaction open (a bare BEGIN with no
        # matching COMMIT) is rolled back before the connection returns to
        # Ignition's shared pool. The SAFETY property (the row was genuinely
        # not changed, no session left idle in transaction) holds regardless
        # of driver quirks and is asserted unconditionally below.
        #
        # On PostgreSQL the notice is reported too (rollBackIfOpen's Javadoc),
        # and must not fire for a run that left nothing open. On MySQL a bare
        # "BEGIN/START TRANSACTION; UPDATE ..." batch needs allowMultiQueries
        # on the connect URL to run as ONE statement at all — this datasource
        # deliberately does not have it (that is also what the multi-statement
        # check above needs to observe), so the induced-open-transaction case
        # is proved separately instead of here; see the report. MSSQL runs
        # multi-statement batches natively (no toggle needed) and gets its own
        # real check in the "MSSQL-specific" section below instead of here,
        # since it needs its own probe table, not SCRATCH.
        if DIALECT == "postgres":
            r = run_sql(page, csrf, f"BEGIN; UPDATE {SCRATCH} SET note = 'should-be-rolled-back' WHERE id = 1")
            record("a run that leaves a transaction open still completes (ok:true) despite no COMMIT",
                   (r["json"] or {}).get("ok") is True, json.dumps(r["json"]))
            record("the open transaction is reported as rolled back",
                   (r["json"] or {}).get("rolledBackTransaction") is True, json.dumps(r["json"]))
            check = run_sql(page, csrf, f"SELECT note FROM {SCRATCH} WHERE id = 1")
            note = ((check["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
            record("the row genuinely was not changed — this is a REAL rollback, not just a reported one",
                   note != "should-be-rolled-back", note)
        elif DIALECT == "mysql":
            record("an uncommitted 'START TRANSACTION; UPDATE ...' is really rolled back",
                   None, "SKIPPED in this automated run — needs allowMultiQueries=true on the "
                         "connect URL to send as one batch; verified separately (row unchanged, "
                         "0 open InnoDB transactions afterwards, no rolledBackTransaction flag — "
                         "silent on non-Postgres per rollBackIfOpen's documented limit) — see the report")
        # mssql: see "BEGIN TRAN; UPDATE ..." in the MSSQL-specific section.

        plain = run_sql(page, csrf, "SELECT 1")
        record("a run with nothing left open reports no rollback",
               (plain["json"] or {}).get("ok") is True
               and not (plain["json"] or {}).get("rolledBackTransaction"), json.dumps(plain["json"]))

        idle = run_sql(page, csrf, open_txn_count_sql())
        idle_n = ((idle["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
        record("no session is left with an open transaction after the run",
               idle_n == 0, f"open-transaction sessions: {idle_n}")

        r = run_sql(page, csrf, f"DROP TABLE {SCRATCH}")
        record("DDL: DROP TABLE", (r["json"] or {}).get("ok") is True, json.dumps(r["json"]))

        # ==================== Errors ====================

        r = run_sql(page, csrf, "SELECT * FROM nonexistent_table_xyz")
        err = (r["json"] or {}).get("error") or {}
        record("syntax/semantic error carries a message and the SQLState",
               (r["json"] or {}).get("ok") is False and "SQLState" in err.get("message", ""),
               json.dumps(err))

        bad = call(page, "api/db-queries/run", "POST",
                   {"runId": "validate-unknown-ds", "datasource": "NoSuchDatasource_xyz", "sql": "SELECT 1"}, csrf)
        record("an unknown datasource is a 200 {ok:false}, not a 500",
               bad["status"] == 200 and bad["json"] and bad["json"].get("ok") is False,
               json.dumps(bad["json"]))

        empty = call(page, "api/db-queries/run", "POST",
                     {"runId": "validate-empty-sql", "datasource": DATASOURCE, "sql": ""}, csrf)
        record("empty SQL is rejected with a 400", empty["status"] == 400, json.dumps(empty["json"]))

        no_csrf = call(page, "api/db-queries/run", "POST",
                        {"runId": "validate-no-csrf", "datasource": DATASOURCE, "sql": "SELECT 1"}, csrf=None)
        record("a write with no CSRF token is refused (403)", no_csrf["status"] == 403,
               json.dumps(no_csrf["json"]))

        wrong_csrf = call(page, "api/db-queries/run", "POST",
                           {"runId": "validate-wrong-csrf", "datasource": DATASOURCE, "sql": "SELECT 1"},
                           csrf="not-the-real-token")
        record("a write with the WRONG CSRF token is refused (403)", wrong_csrf["status"] == 403,
               json.dumps(wrong_csrf["json"]))

        ds_status = call(page, "api/db-queries/datasources", "GET")
        faulted = [d for d in (ds_status["json"] or {}).get("datasources", []) if d["status"] != "VALID"]
        if faulted:
            record("a faulted/disconnected datasource is reported with its real status",
                   True, json.dumps(faulted))
        else:
            record("a faulted/disconnected datasource is reported with its real status",
                   None, "SKIPPED — every datasource on this gateway is VALID; none deliberately "
                          "faulted to avoid disrupting the other demo projects that depend on them")

        # ==================== Schema tree ====================
        # H5/H6 fix (Web IDE 1.27.2): SdkDbSchema now passes
        # connection.getCatalog() to getTables/getColumns instead of null —
        # this checks BOTH directions of that fix: MySQL/MSSQL's tree must no
        # longer leak another database's tables, and Postgres's tree must
        # still show its OWN tables (an explicit catalog must not empty it).
        tabs = call(page, "api/db-queries/tables?datasource=" + DATASOURCE)
        # A: the tables route now answers {schema, name, type} rows, not bare
        # names — every existing check below only ever needed the name.
        seen = {row["name"] for row in (tabs["json"] or {}).get("tables", [])}
        if DIALECT == "mysql":
            own_expected = {QB_TAB, QB_XTAB, QB_VIEW}
            record("schema tree lists the connected database's own tables",
                   own_expected.issubset(seen), f"seen={sorted(seen)}")
            record("a VIEW is listed in the schema tree alongside base tables",
                   QB_VIEW in seen, f"seen={sorted(seen)}")
            record("schema tree is scoped to the connected database — another database's table is NOT listed",
                   QB_OTHER_TABLE not in seen,
                   f"seen={sorted(seen)}; '{QB_OTHER_TABLE}' lives in '{QB_OTHER_DB}' (SELECT granted to "
                   f"the same user) and must not appear now that getTables/getColumns pass an explicit catalog")

            cols_tab = call(page, f"api/db-queries/columns?datasource={DATASOURCE}&table={QB_TAB}")
            cols_xtab = call(page, f"api/db-queries/columns?datasource={DATASOURCE}&table={QB_XTAB}")
            tab_names = {c["name"] for c in (cols_tab["json"] or {}).get("columns", [])}
            xtab_names = {c["name"] for c in (cols_xtab["json"] or {}).get("columns", [])}
            record("a table name containing '_' does not pull in a look-alike table's columns",
                   tab_names == {"id", "label"} and xtab_names == {"id", "other_col"},
                   f"{QB_TAB}={sorted(tab_names)} {QB_XTAB}={sorted(xtab_names)}")

            run_sql(page, csrf, "DROP TABLE IF EXISTS qb_blob_probe")
            run_sql(page, csrf, "CREATE TABLE qb_blob_probe (id INT PRIMARY KEY, data BLOB)")
            run_sql(page, csrf, "INSERT INTO qb_blob_probe VALUES (1, REPEAT('x', 12345))")
            r = run_sql(page, csrf, "SELECT data FROM qb_blob_probe WHERE id=1")
            val = ((r["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
            record("a BLOB value is shown as its byte length, not raw bytes", val == "12345 bytes", val)
            run_sql(page, csrf, "DROP TABLE qb_blob_probe")

            # USE-leak burst test (H6 fix, Web IDE 1.27.3): the connection
            # is meant to go back to connection.getCatalog()'s ORIGINAL value
            # after every run. Reported with evidence either way — if
            # Connector/J's own client-side catalog cache never learned about
            # the raw "USE scriptide_qb_other" (it bypasses Connection.setCatalog()
            # entirely), a later setCatalog("scriptide_qb") can be a driver-side
            # no-op against a cache that already reads "scriptide_qb", leaving
            # the SERVER still on scriptide_qb_other.
            burst_js = """
            async ({ spa, csrf, ds, sqls }) => Promise.all(sqls.map((sql, i) => fetch(spa + 'api/db-queries/run', {
              method: 'POST', credentials: 'include',
              headers: {'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':csrf},
              body: JSON.stringify({runId: 'burst-' + i + '-' + Date.now(), datasource: ds, sql: sql}),
            }).then(r => r.json())))
            """
            page.evaluate(burst_js, {"spa": SPA_PATH, "csrf": csrf, "ds": DATASOURCE,
                                      "sqls": ["USE scriptide_qb_other"] * 10})
            burst = page.evaluate(burst_js, {"spa": SPA_PATH, "csrf": csrf, "ds": DATASOURCE,
                                              "sqls": ["SELECT DATABASE() AS db"] * 10})
            burst_dbs = [((x.get("results") or [{}])[0].get("rows") or [[None]])[0][0] for x in burst if x.get("ok")]
            leaked_count = sum(1 for d in burst_dbs if d == "scriptide_qb_other")
            record("USE scriptide_qb_other does not leak across pooled connections under concurrent load",
                   leaked_count == 0 and len(burst_dbs) > 0,
                   f"{leaked_count}/{len(burst_dbs)} concurrent follow-up runs landed in "
                   f"'scriptide_qb_other' instead of 'scriptide_qb': {burst_dbs}")
            if leaked_count > 0:
                # Bring the pool's connections back before the rest of the
                # suite runs any more queries against this datasource.
                page.evaluate(burst_js, {"spa": SPA_PATH, "csrf": csrf, "ds": DATASOURCE,
                                          "sqls": ["USE scriptide_qb"] * 10})
        elif DIALECT == "mssql":
            own_expected = {QB_TAB, QB_XTAB, QB_VIEW}
            record("schema tree lists tables from a non-dbo schema (qb.qb_tab et al)",
                   own_expected.issubset(seen), f"seen contains {len(seen)} entries; "
                   f"qb.* fixtures present: {sorted(own_expected & seen)}")
            record("a VIEW is listed in the schema tree alongside base tables",
                   QB_VIEW in seen, f"qb.* fixtures present: {sorted(own_expected & seen)}")
            record("schema tree is scoped to the connected database — another database's table is NOT listed",
                   QB_OTHER_TABLE not in seen,
                   f"'{QB_OTHER_TABLE}' lives in '{QB_OTHER_DB}' (read access granted to the same login) "
                   f"and must not appear now that getTables/getColumns pass an explicit catalog")
            # H7 fix (Web IDE 1.27.3): SdkDbSchema now drops TABLE_SCHEM
            # sys/INFORMATION_SCHEMA/pg_catalog rows, so the tree should show
            # EXACTLY the qb.* fixtures now — nothing else. A handful of
            # well-known system view names as a fallback signal, in case a
            # differently-named leak slips through the fix.
            system_markers = {"dm_exec_requests", "dm_exec_sessions", "objects", "all_columns",
                               "sysobjects", "spt_values", "TABLES", "COLUMNS"}
            leaked = system_markers & seen
            record("no system tables/views flood the tree (sys/INFORMATION_SCHEMA dropped)",
                   # The suite's own mixed-case and reserved-word tables are expected extras.
                   not leaked and own_expected <= seen
                   and all(n == "order" or n.startswith("MixedCase_") for n in seen - own_expected),
                   f"seen={sorted(seen)} (expected exactly {sorted(own_expected)}); "
                   f"system-view names present: {sorted(leaked) if leaked else 'none'}")

            cols_tab = call(page, f"api/db-queries/columns?datasource={DATASOURCE}&table={QB_TAB}")
            cols_xtab = call(page, f"api/db-queries/columns?datasource={DATASOURCE}&table={QB_XTAB}")
            tab_names = {c["name"] for c in (cols_tab["json"] or {}).get("columns", [])}
            xtab_names = {c["name"] for c in (cols_xtab["json"] or {}).get("columns", [])}
            record("a table name containing '_' does not pull in a look-alike table's columns",
                   tab_names == {"id", "label"} and xtab_names == {"id", "other_col"},
                   f"{QB_TAB}={sorted(tab_names)} {QB_XTAB}={sorted(xtab_names)}")

            run_sql(page, csrf, "DROP TABLE IF EXISTS qb_varbinary_probe")
            run_sql(page, csrf, "CREATE TABLE qb_varbinary_probe (id INT PRIMARY KEY, data VARBINARY(MAX))")
            # REPLICATE on a bare literal infers VARCHAR(1) and truncates its
            # result at the classic non-MAX 8000-byte ceiling — CAST the
            # INPUT to VARCHAR(MAX) first so the 12345-byte output survives.
            run_sql(page, csrf,
                    "INSERT INTO qb_varbinary_probe VALUES (1, "
                    "CAST(REPLICATE(CAST('x' AS VARCHAR(MAX)), 12345) AS VARBINARY(MAX)))")
            r = run_sql(page, csrf, "SELECT data FROM qb_varbinary_probe WHERE id=1")
            val = ((r["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
            record("a VARBINARY(MAX) value is shown as its byte length, not raw bytes", val == "12345 bytes", val)
            run_sql(page, csrf, "DROP TABLE qb_varbinary_probe")

            # UPDATED for 1.29.0: double-click now inserts the SCHEMA-QUALIFIED
            # name (see "A" below), fixing the deferred item this check used to
            # document — so this is no longer "evidence of a known limitation",
            # just a plain SQL-identifier-resolution fact: a BARE reference to
            # a table outside the connection's default schema (dbo) still
            # fails, which is exactly why the UI qualifying it matters.
            r = run_sql(page, csrf, f"SELECT * FROM {QB_TAB}")
            ok = (r["json"] or {}).get("ok")
            record("a bare (unqualified) reference to a non-dbo table still fails at the SQL level "
                   "(unrelated to the UI fix — dbo is still the resolution default)",
                   ok is False, json.dumps((r["json"] or {}).get("error")))
        else:
            record("catalog scoping does not empty the schema tree — the connected database's own tables "
                   "are still listed",
                   "oi_customer" in seen, f"{len(seen)} tables seen; oi_customer "
                   + ("present" if "oi_customer" in seen else "MISSING"))

        # ==================== Temporal precision ====================
        # H5 fix (Web IDE 1.27.2): a TIME column is now read via
        # getObject(i, LocalTime.class) instead of the default getObject(i),
        # which used to hand back a java.sql.Time and silently drop
        # fractional seconds on toLocalTime(). Checked on all three dialects —
        # TIME(3) is valid syntax on each, and the fix is driver-agnostic.
        run_sql(page, csrf, "DROP TABLE IF EXISTS qb_temporal_probe")
        if DIALECT == "mysql":
            run_sql(page, csrf, "CREATE TABLE qb_temporal_probe "
                                 "(d DATE, t TIME(3), dt DATETIME(3), ts TIMESTAMP(3) NULL)")
            run_sql(page, csrf, "INSERT INTO qb_temporal_probe VALUES "
                                 "('2026-09-29','13:45:30.500','2026-09-29 13:45:30.500',"
                                 "'2026-09-29 13:45:30.250')")
            r = run_sql(page, csrf, "SELECT d, t, dt, ts FROM qb_temporal_probe")
            row = ((r["json"] or {}).get("results") or [{}])[0].get("rows", [[None] * 4])[0]
            record("DATE renders as a plain ISO date", row[0] == "2026-09-29", row[0])
            record("TIME(3) keeps its fractional seconds exactly", row[1] == "13:45:30.500", row[1])
            record("DATETIME(3) renders as a local ISO datetime with fractional seconds kept",
                   row[2] == "2026-09-29T13:45:30.500", row[2])
            # MySQL TIMESTAMP is stored as UTC but returned in the session's
            # zone, as wall-clock time, like DATETIME.
            record("TIMESTAMP(3) renders as wall-clock ISO with fractional seconds, no 'Z'",
                   row[3] == "2026-09-29T13:45:30.250", row[3])
        elif DIALECT == "mssql":
            run_sql(page, csrf, "CREATE TABLE qb_temporal_probe "
                                 "(d DATE, t TIME(3), dt DATETIME2(3), tso DATETIMEOFFSET(3), "
                                 "tso10 DATETIMEOFFSET(3))")
            run_sql(page, csrf, "INSERT INTO qb_temporal_probe VALUES ("
                                 "'2026-09-29', '13:45:30.500', '2026-09-29 13:45:30.500', "
                                 "'2026-09-29 13:45:30.250 +00:00', '2026-09-29 13:45:30.250 +10:00')")
            r = run_sql(page, csrf, "SELECT d, t, dt, tso, tso10 FROM qb_temporal_probe")
            row = ((r["json"] or {}).get("results") or [{}])[0].get("rows", [[None] * 5])[0]
            record("DATE renders as a plain ISO date", row[0] == "2026-09-29", row[0])
            record("TIME(3) keeps its fractional seconds exactly", row[1] == "13:45:30.500", row[1])
            record("DATETIME2(3) renders as wall-clock ISO, no 'Z' (it carries no zone)",
                   row[2] == "2026-09-29T13:45:30.500", row[2])
            # H8 fix (Web IDE 1.27.3): DATETIMEOFFSET is now read as
            # OffsetDateTime, so it renders through the Temporal ISO-8601
            # path instead of falling through to a raw toString(). A zero
            # offset renders as "Z" (OffsetDateTime.toString()'s own
            # convention for ZoneOffset.UTC — still exactly ISO-8601, just
            # not literally "+00:00"), a non-zero offset keeps its own
            # "+10:00" suffix.
            record("DATETIMEOFFSET(3) with a zero offset renders as a clean ISO-8601 instant",
                   row[3] == "2026-09-29T13:45:30.250Z", row[3])
            record("DATETIMEOFFSET(3) with a non-zero (+10:00) offset renders as ISO-8601 with that offset kept",
                   row[4] == "2026-09-29T13:45:30.250+10:00", row[4])
        else:
            run_sql(page, csrf, "CREATE TABLE qb_temporal_probe (t TIME(3))")
            run_sql(page, csrf, "INSERT INTO qb_temporal_probe VALUES ('13:45:30.500')")
            r = run_sql(page, csrf, "SELECT t FROM qb_temporal_probe")
            val = ((r["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
            record("TIME(3) keeps its fractional seconds exactly", val == "13:45:30.500", val)
        run_sql(page, csrf, "DROP TABLE qb_temporal_probe")

        # ==================== MSSQL-specific ====================
        if DIALECT == "mssql":
            # Multi-statement batches and a BEGIN TRAN/rollback both run
            # NATIVELY on MSSQL — no allowMultiQueries-style connection
            # property needed, unlike MySQL. Proved directly here, in the
            # normal automated run (not a separate toggle pass).
            r = run_sql(page, csrf, "SELECT 1 AS a; SELECT 2 AS b;")
            results_list = (r["json"] or {}).get("results")
            record("a multi-statement batch works natively (two results, no connection property needed)",
                   bool(results_list) and len(results_list) == 2, json.dumps(results_list))

            run_sql(page, csrf, "DROP TABLE IF EXISTS qb_txn_probe")
            run_sql(page, csrf, "CREATE TABLE qb_txn_probe (id INT PRIMARY KEY, note VARCHAR(50))")
            run_sql(page, csrf, "INSERT INTO qb_txn_probe VALUES (1, 'original')")
            r = run_sql(page, csrf, f"{begin_tran_sql()}; UPDATE qb_txn_probe SET note = "
                                     "'should-be-rolled-back' WHERE id = 1")
            record("BEGIN TRAN; UPDATE ... still completes (ok:true) despite no COMMIT",
                   (r["json"] or {}).get("ok") is True, json.dumps(r["json"]))
            check = run_sql(page, csrf, "SELECT note FROM qb_txn_probe WHERE id = 1")
            note = ((check["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
            record("the row genuinely was not changed — this is a REAL rollback, not just a reported one",
                   note != "should-be-rolled-back", note)
            idle = run_sql(page, csrf, open_txn_count_sql())
            idle_n = ((idle["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
            record("no session under our login is left with an open transaction after the run",
                   idle_n == 0, f"open-transaction sessions (login=scriptide_qb): {idle_n}")
            run_sql(page, csrf, "DROP TABLE qb_txn_probe")

            # USE master: does the session-state change leak forward onto the
            # NEXT run on the pool? H6 fix (Web IDE 1.27.3): the connection
            # is put back in the catalog it was borrowed in
            # (connection.setCatalog(original)) after every run, so this
            # should no longer leak either sequentially or under the
            # pool-exhausting concurrent burst that used to demonstrate it.
            u = run_sql(page, csrf, "USE master")
            d = run_sql(page, csrf, "SELECT DB_NAME() AS db")
            seq_db = ((d["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
            record("USE master then an immediate sequential run lands back in scriptide_qb",
                   seq_db == "scriptide_qb", f"DB_NAME() on the very next run = {seq_db!r}")

            burst_js = """
            async ({ spa, csrf, ds, sqls }) => Promise.all(sqls.map((sql, i) => fetch(spa + 'api/db-queries/run', {
              method: 'POST', credentials: 'include',
              headers: {'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':csrf},
              body: JSON.stringify({runId: 'burst-' + i + '-' + Date.now(), datasource: ds, sql: sql}),
            }).then(r => r.json())))
            """
            page.evaluate(burst_js, {"spa": SPA_PATH, "csrf": csrf, "ds": DATASOURCE, "sqls": ["USE master"] * 10})
            burst = page.evaluate(burst_js, {"spa": SPA_PATH, "csrf": csrf, "ds": DATASOURCE,
                                              "sqls": ["SELECT DB_NAME() AS db"] * 10})
            burst_dbs = [((x.get("results") or [{}])[0].get("rows") or [[None]])[0][0] for x in burst if x.get("ok")]
            leaked_count = sum(1 for d in burst_dbs if d == "master")
            record("USE master no longer leaks across pooled connections under concurrent load",
                   leaked_count == 0 and len(burst_dbs) > 0,
                   f"{leaked_count}/{len(burst_dbs)} concurrent follow-up runs landed in 'master' "
                   f"instead of 'scriptide_qb': {burst_dbs}")

        # ==================== Stop ====================

        # Launched but not awaited from this side: `POST /run` blocks until the
        # query finishes, so proving Stop needs the request in flight while a
        # SEPARATE fetch cancels it — exactly the race the client-generated
        # runId exists for (see runId.ts / DbQueryRouteHandler's class Javadoc).
        start_long_js = """
        (args) => {
          window.__qbValidateRun = fetch(args.spa + 'api/db-queries/run', {
            method: 'POST', credentials: 'include',
            headers: {'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':args.csrf},
            body: JSON.stringify({runId: args.runId, datasource: args.datasource, sql: args.sql}),
          }).then(r => r.json());
          return true;
        }
        """
        stop_run_id = "validate-stop-1"
        page.evaluate(start_long_js, {
            "spa": SPA_PATH, "csrf": csrf, "runId": stop_run_id,
            "datasource": DATASOURCE, "sql": sleep_sql(20),
        })
        time.sleep(2)  # let the statement actually reach the database first
        cancel = call(page, "api/db-queries/cancel", "POST", {"runId": stop_run_id}, csrf)
        record("cancelling a running query answers ok:true",
               cancel["json"] and cancel["json"].get("ok") is True, json.dumps(cancel["json"]))

        finished = page.evaluate("async () => await window.__qbValidateRun")
        record("a stopped run reports {type:'Stopped', message:'The query was stopped.'}",
               finished.get("ok") is False and finished.get("error", {}).get("type") == "Stopped",
               json.dumps(finished))

        # The client is told it stopped; prove the DATABASE agrees — the
        # session must not still be sitting inside pg_sleep on the server.
        # `pid <> pg_backend_pid()` excludes the checking query's OWN row: its
        # query text literally contains the substring "pg_sleep" (inside the
        # '%pg_sleep%' pattern) and it is itself 'active' while it runs, which
        # otherwise makes this check find itself every single time. Postgres's
        # cancel is asynchronous (the backend notices it at its next
        # interruptible point), so this still polls briefly rather than
        # asserting on the very next instant.
        n = None
        for _ in range(10):
            check = run_sql(page, csrf, active_sleep_count_sql())
            n = ((check["json"] or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
            if n == 0:
                break
            time.sleep(0.2)
        record("the cancelled session is really gone server-side, not just marked stopped client-side",
               n == 0, f"active sleep sessions still on the server: {n}")

        # A schema load puts a 30 s network timeout on the pooled connection it
        # borrows. Left there, the next borrower's query over 30 s died with a
        # link failure (08S01 / 08006). A column read of a table name nothing
        # has cached forces a load, and the pool hands the same connection back
        # next, so a 35 s sleep straight after must complete normally.
        for attempt in range(2):
            call(page, f"api/db-queries/columns?datasource={DATASOURCE}&table=qb_nocache_{RUN_TOKEN}_{attempt}")
            print("  (35 s sleep straight after a schema load...)")
            t0 = time.time()
            r = run_sql(page, csrf, sleep_sql(35), run_id=f"validate-after-schema-{attempt}")
            record(f"a 35 s query straight after a schema load completes (no 30 s timeout left on the pool), try {attempt + 1}",
                   (r["json"] or {}).get("ok") is True,
                   f"elapsed={time.time() - t0:.1f}s body={json.dumps(r['json'])[:200]}")

        # ExecPolicy's own timeout (default 60s), with no Stop click at all —
        # a 65-second sleep must be aborted before its natural completion.
        print("  (waiting up to ~65s for ExecPolicy's query timeout to fire...)")
        t0 = time.time()
        r = run_sql(page, csrf, sleep_sql(65), run_id="validate-timeout")
        elapsed = time.time() - t0
        # Both bounds matter: elapsed < 64 alone would also pass if the run
        # failed almost immediately for some UNRELATED reason — asserting
        # elapsed >= 55 too proves the timeout is what actually stopped it,
        # not a bug that aborts every run near-instantly.
        record("ExecPolicy's query timeout aborts a long query with no Stop click, in roughly its configured window",
               (r["json"] or {}).get("ok") is False and 55 <= elapsed < 64
               and ((r["json"] or {}).get("error") or {}).get("type") == "TimedOut",
               f"elapsed={elapsed:.1f}s body={json.dumps(r['json'])}")

        # ==================== Security ====================

        def unauthenticated_status(path, method="GET", body=None):
            """A plain urllib request, deliberately outside Playwright's cookie
            jar — "no session" means no session, not "a session that happens
            not to be logged in"."""
            req = urllib.request.Request(
                GATEWAY_URL + api(path), method=method,
                data=json.dumps(body).encode() if body is not None else None,
                headers={"Content-Type": "application/json"} if body is not None else {},
            )
            try:
                urllib.request.urlopen(req, timeout=10)
                return 200
            except urllib.error.HTTPError as e:
                return e.code

        record("no session at all -> 401 on a read route",
               unauthenticated_status("/api/db-queries/tables?datasource=" + DATASOURCE) == 401)
        record("no session at all -> 401 on the run route",
               unauthenticated_status("/api/db-queries/run", "POST", {}) == 401)

        if CONTAINER:
            # Back up whatever is there FIRST — this file is a real module
            # policy override, and on a gateway other than this rig's it may
            # already hold real content. Overwrite-then-delete would silently
            # destroy that. `test -f` then `cat` rather than a single command
            # with a sentinel string, so real content that happens to look
            # like a sentinel is never misread as "absent".
            exists = subprocess.run(
                ["docker", "exec", CONTAINER, "sh", "-c", f"test -f {POLICY_FILE}"],
                capture_output=True, timeout=15).returncode == 0
            backup = None
            if exists:
                backup = subprocess.run(
                    ["docker", "exec", CONTAINER, "cat", POLICY_FILE],
                    check=True, capture_output=True, timeout=15).stdout
            try:
                subprocess.run(
                    ["docker", "exec", CONTAINER, "sh", "-c",
                     f"echo 'com.gaskony.scriptide.execution.enabled=false' > {POLICY_FILE}"],
                    check=True, capture_output=True, timeout=15)
                time.sleep(3)  # the policy file is re-statted every 2s, not instantly
                disabled = run_sql(page, csrf, "SELECT 1", run_id="validate-policy-disabled")
                record("execution.enabled=false in policy.properties refuses a run with 403",
                       disabled["status"] == 403, json.dumps(disabled["json"]))
            finally:
                if backup is None:
                    subprocess.run(["docker", "exec", CONTAINER, "rm", "-f", POLICY_FILE],
                                    check=False, capture_output=True, timeout=15)
                else:
                    # Restore the EXACT original bytes via stdin, not string
                    # interpolation, so this is safe whatever the file held.
                    subprocess.run(["docker", "exec", "-i", CONTAINER, "sh", "-c", f"cat > {POLICY_FILE}"],
                                    input=backup, check=False, capture_output=True, timeout=15)
                time.sleep(3)
                restored = run_sql(page, csrf, "SELECT 1", run_id="validate-policy-restored")
                record("policy.properties is restored exactly (or removed if it was absent), and execution resumes",
                       restored["status"] == 200 and (restored["json"] or {}).get("ok") is True,
                       json.dumps(restored["json"]))
        else:
            record("execution.enabled=false in policy.properties refuses a run with 403",
                   None, "SKIPPED — config.local.json has no container_name")
            record("removing policy.properties restores execution",
                   None, "SKIPPED — config.local.json has no container_name")

        # ==================== History ====================

        hist = call(page, "api/db-queries/history", "GET")
        record("history includes a run from THIS suite", hist["status"] == 200
               and any(SCRATCH in e.get("sql", "") for e in hist["json"].get("runs", [])),
               f"{len(hist['json'].get('runs', []))} runs on record")

        maxRuns = hist["json"].get("maxRuns")
        for i in range(maxRuns + 5):
            run_sql(page, csrf, f"SELECT {i}", run_id=f"validate-cap-{i}")
        hist2 = call(page, "api/db-queries/history", "GET")
        record(f"history is capped at maxRuns ({maxRuns})",
               len(hist2["json"].get("runs", [])) == maxRuns,
               f"{len(hist2['json'].get('runs', []))} runs on record")

        # ==================== Non-admin / cross-user ====================
        # Temporary accounts in the CORRECT user source (TEMP_USER_SOURCE —
        # see its module-level comment), passwords generated at runtime and
        # never printed or stored, removed in a finally block regardless of
        # what fails above it.
        # Short deliberately: a long username (the full PREFIX plus a role
        # tag) made the user-sources grid time out finding the row again for
        # role assignment on this rig — confirmed live 28/09/2026, and short
        # names confirmed reliable in the same session.
        nonadmin_user = "sqb_na_" + RUN_TOKEN
        nonadmin_password = secrets.token_urlsafe(18)
        admin2_user = "sqb_a2_" + RUN_TOKEN
        admin2_password = secrets.token_urlsafe(18)
        nonadmin_ctx = None
        admin2_ctx = None
        try:
            create_temp_user(page, nonadmin_user, nonadmin_password)
            create_temp_user(page, admin2_user, admin2_password)
            make_temp_user_admin(page, admin2_user)

            nonadmin_ctx = browser.new_context(viewport={"width": 1400, "height": 900})
            nonadmin_page = nonadmin_ctx.new_page()
            login_as(nonadmin_page, nonadmin_user, nonadmin_password)
            nonadmin_page.goto(GATEWAY_URL + SPA_PATH, wait_until="load", timeout=30000)
            nonadmin_session = nonadmin_page.evaluate(
                "async (spa) => { const r = await fetch(spa + 'api/auth/session',"
                " {credentials: 'include'}); return await r.json(); }", SPA_PATH,
            )
            record("a roleless user in the temp user source authenticates but cannot execute",
                   nonadmin_session.get("authenticated") is True
                   and nonadmin_session.get("canExecute") is False
                   and nonadmin_session.get("roles") == [],
                   json.dumps(nonadmin_session))
            nonadmin_csrf = nonadmin_session.get("csrfToken")

            t = call(nonadmin_page, "api/db-queries/tables?datasource=" + DATASOURCE)
            record("non-admin -> 403 on tables", t["status"] == 403, json.dumps(t["json"]))
            c = call(nonadmin_page, f"api/db-queries/columns?datasource={DATASOURCE}&table=oi_customer")
            record("non-admin -> 403 on columns", c["status"] == 403, json.dumps(c["json"]))
            rr = run_sql(nonadmin_page, nonadmin_csrf, "SELECT 1", run_id="validate-nonadmin-run")
            record("non-admin -> 403 on run", rr["status"] == 403, json.dumps(rr["json"]))
            cc = call(nonadmin_page, "api/db-queries/cancel", "POST", {"runId": "anything"}, nonadmin_csrf)
            record("non-admin -> 403 on cancel", cc["status"] == 403, json.dumps(cc["json"]))

            # The UI's own denied state, not just the API — a screenshot,
            # self-checked for the notice text and a disabled Run button.
            nonadmin_page.goto(GATEWAY_URL + SPA_PATH + "?view=query&project=Template",
                                wait_until="load", timeout=30000)
            nonadmin_page.wait_for_selector(".qb-denied", timeout=15000)
            shot_path = os.path.join(tempfile.gettempdir(), "nonadmin_query_denied.png")
            nonadmin_page.screenshot(path=shot_path)
            denied_text = nonadmin_page.locator(".qb-denied").inner_text()
            run_disabled = nonadmin_page.get_by_role("button", name="Run", exact=True).is_disabled()
            record("non-admin UI shows the canExecute=false notice and a disabled Run button",
                   "Administrator role" in denied_text and run_disabled,
                   f"notice={denied_text!r} screenshot={shot_path}")

            # Cross-user cancel: A (this suite's own admin session) starts a
            # long run; B (a DIFFERENT Administrator account) tries to cancel
            # it and must get 404 — the RunKey is (runId, username), so B's
            # attempt looks up a key that was never filed under B's name, no
            # matter that B also has permission to cancel SOMETHING.
            admin2_ctx = browser.new_context(viewport={"width": 1400, "height": 900})
            admin2_page = admin2_ctx.new_page()
            login_as(admin2_page, admin2_user, admin2_password)
            admin2_page.goto(GATEWAY_URL + SPA_PATH, wait_until="load", timeout=30000)
            admin2_session = admin2_page.evaluate(
                "async (spa) => { const r = await fetch(spa + 'api/auth/session',"
                " {credentials: 'include'}); return await r.json(); }", SPA_PATH,
            )
            admin2_csrf = admin2_session.get("csrfToken")

            cross_run_id = "validate-cross-user-1"
            page.evaluate(start_long_js, {
                "spa": SPA_PATH, "csrf": csrf, "runId": cross_run_id,
                "datasource": DATASOURCE, "sql": sleep_sql(8),
            })
            time.sleep(2)
            cross_cancel = call(admin2_page, "api/db-queries/cancel", "POST",
                                 {"runId": cross_run_id}, admin2_csrf)
            record("a different user cancelling A's run gets 404, not ok:true",
                   cross_cancel["status"] == 404, json.dumps(cross_cancel["json"]))

            cross_finished = page.evaluate("async () => await window.__qbValidateRun")
            record("A's query completes normally despite B's failed cancel attempt",
                   cross_finished.get("ok") is True, json.dumps(cross_finished))
        finally:
            delete_temp_user(page, nonadmin_user)
            delete_temp_user(page, admin2_user)
            if nonadmin_ctx:
                nonadmin_ctx.close()
            if admin2_ctx:
                admin2_ctx.close()

        # ==================== UI automation ====================
        # Everything below drives the REAL rendered SPA, not just its API —
        # the popped-out single-panel view (?view=query), same shape
        # a11y.json already screenshots, on a known table+column (UI_TABLE /
        # UI_COLUMN — oi_customer/customer_code on Postgres_Test's own real
        # schema, this suite's own QB_TAB fixture on MySQL_QB_Test).
        page.goto(GATEWAY_URL + SPA_PATH + "?view=query&project=Template", wait_until="load", timeout=30000)
        page.get_by_label("Datasource").select_option(DATASOURCE)
        page.wait_for_selector(".qb-table-name", timeout=15000)

        page.fill(".qb-filter", UI_FILTER)
        visible_tables = page.locator(".qb-table-name").all_inner_texts()
        record("the filter box narrows the tree to matching table names",
               visible_tables == [UI_TABLE_QUALIFIED], visible_tables)
        page.fill(".qb-filter", "")

        set_editor_text(page, "")
        page.get_by_label(f"Expand {UI_TABLE_QUALIFIED}").click()
        page.wait_for_selector(".qb-column-name", timeout=10000)
        page.locator(".qb-column-name", has_text=UI_COLUMN).first.click()
        record("clicking a column inserts its name at the cursor",
               editor_text(page).strip() == UI_COLUMN, editor_text(page))

        set_editor_text(page, "")
        page.locator(".qb-table-name", has_text=UI_TABLE_QUALIFIED).dblclick()
        record("double-clicking a table inserts a SELECT * for it, schema-qualified where needed",
               editor_text(page).strip() == f"SELECT * FROM {UI_TABLE_QUALIFIED}", editor_text(page))

        # Ctrl+Enter with a selection runs ONLY the selection, not the buffer.
        set_editor_text(page, "SELECT 101\nSELECT 202")
        page.keyboard.press("Home")
        page.keyboard.press("Shift+End")
        page.keyboard.press("Control+Enter")
        page.wait_for_timeout(1500)
        hist_after_selection = call(page, "api/db-queries/history", "GET")
        newest = (hist_after_selection["json"].get("runs") or [{}])[0]
        record("Ctrl+Enter with a selection runs only the selected line, recorded verbatim in history",
               newest.get("sql") == "SELECT 202", json.dumps(newest))

        # Datasource and SQL survive a reload (localStorage), independent of
        # the tree/expansion state, which does not.
        set_editor_text(page, "SELECT 'reload-check' AS marker")
        page.wait_for_timeout(300)
        page.reload(wait_until="load")
        page.wait_for_selector(".qb-editor .cm-content", timeout=15000)
        page.wait_for_timeout(500)
        restored_ds = page.get_by_label("Datasource").input_value()
        record("datasource is restored after a reload",
               restored_ds == DATASOURCE, restored_ds)
        record("SQL text is restored after a reload",
               editor_text(page).strip() == "SELECT 'reload-check' AS marker", editor_text(page))

        # Big numbers: the wire JSON was already proven exact above (see
        # "Results"); this checks what a person actually SEES — the rendered
        # grid cell and the TSV a Copy click puts on the clipboard — now that
        # H3 sends an unsafe-integer Long as a STRING rather than a JSON
        # number a browser's own JSON.parse would silently round.
        set_editor_text(page, "SELECT 9007199254740993 AS big")
        page.click(".qb-toolbar button.primary")
        page.wait_for_selector(".qb-table td", timeout=15000)
        cell = page.locator(".qb-table td").first
        record("a bigint past 2^53 renders its exact digits in the grid, not a rounded value",
               cell.inner_text() == "9007199254740993", cell.inner_text())
        record("that numeric cell is right-aligned even though it travelled as a string",
               "qb-col-numeric" in (cell.get_attribute("class") or ""), cell.get_attribute("class"))

        # `navigator.clipboard` does not exist here at all (confirmed: even
        # with clipboard-read/write granted, window.isSecureContext is false
        # on plain HTTP, so the object itself is undefined, not merely
        # permission-denied) — the same gap clipboard.ts's own Javadoc-style
        # comment documents, and exactly why copyText() falls back to
        # document.execCommand('copy'). Reading the OS clipboard back through
        # execCommand('paste') is ALSO blocked by Chromium unconditionally.
        # So this intercepts execCommand('copy') itself and captures the
        # selected textarea's value at the moment of the call — the exact
        # text the legacy fallback path (the one real users on this gateway
        # actually exercise) hands to the browser, which is a more faithful
        # check here than forcing the modern API through a flag would be.
        page.evaluate("""() => {
            window.__qbCopiedText = null;
            const real = document.execCommand.bind(document);
            document.execCommand = (cmd, ...rest) => {
                if (cmd === 'copy' && document.activeElement && 'value' in document.activeElement) {
                    window.__qbCopiedText = document.activeElement.value;
                }
                return real(cmd, ...rest);
            };
        }""")
        page.click(".qb-copy")
        page.wait_for_timeout(300)
        clip = page.evaluate("() => window.__qbCopiedText")
        record("Copy as TSV puts the exact digits into the legacy copy call's selected text",
               clip is not None and "9007199254740993" in clip, clip)

        if DIALECT == "mssql":
            # Same rendered-grid/TSV proof, for a DECIMAL(38,9) value instead
            # of a bigint — the wire-level exactness was already proven in
            # "Results"; this is what a person actually sees.
            set_editor_text(page, "SELECT CAST(123456789012345.678901234 AS DECIMAL(38,9)) AS num")
            page.click(".qb-toolbar button.primary")
            page.wait_for_selector(".qb-table td", timeout=15000)
            cell = page.locator(".qb-table td").first
            record("DECIMAL(38,9) renders its exact digits in the grid",
                   cell.inner_text() == "123456789012345.678901234", cell.inner_text())
            page.click(".qb-copy")
            page.wait_for_timeout(300)
            clip = page.evaluate("() => window.__qbCopiedText")
            record("DECIMAL(38,9) keeps its exact digits in the TSV copy",
                   clip is not None and "123456789012345.678901234" in clip, clip)

        # Keyboard-only: Tab reaches the tree, Enter operates a focused
        # button. NOTE — the tree is a plain sequence of <button>s, not an
        # ARIA `tree`/`treeitem` widget with roving-tabindex arrow-key
        # navigation, so "arrow keys expand" is not something this component
        # implements; Tab (native browser focus order) and Enter (native
        # button activation) are what actually works, and are what this
        # checks. Reported factually rather than claiming arrow-key support
        # that is not there.
        set_editor_text(page, "")
        page.fill(".qb-filter", UI_FILTER)
        # Wait for the filtered tree to actually settle to one row before
        # tabbing through it — by this point in the suite the page has done
        # a lot (a reload, several runs), and firing Tab immediately after
        # .fill() raced React's own re-render on this rig: Tab landed
        # somewhere other than UI_TABLE's disclosure button.
        page.wait_for_function(
            "(t) => document.querySelectorAll('.qb-table-name').length === 1"
            " && document.querySelector('.qb-table-name').textContent === t",
            arg=UI_TABLE_QUALIFIED, timeout=10000,
        )
        def focused():
            return page.evaluate("""() => {
                const e = document.activeElement;
                if (!e) return null;
                return {tag: e.tagName, cls: e.className, aria: e.getAttribute('aria-label')};
            }""")

        def tab_until(expected_class, expected_aria=None, attempts=3):
            """Press Tab, and if focus did not land where expected, wait a beat
            and retry — self-verifying rather than a blind, timing-dependent
            single Tab, since this exact step raced a React re-render under
            full-suite load on this rig (passed reliably in isolation)."""
            for attempt in range(attempts):
                page.keyboard.press("Tab")
                seen = focused()
                if seen and expected_class in (seen.get("cls") or "") and (
                        expected_aria is None or seen.get("aria") == expected_aria):
                    return seen
                page.wait_for_timeout(300)
            return seen

        page.locator(".qb-filter").focus()
        landed_disclosure = tab_until("qb-disclosure", f"Expand {UI_TABLE_QUALIFIED}")
        page.keyboard.press("Enter")  # expand it
        page.wait_for_selector(".qb-column-name", timeout=10000)
        landed_table_name = tab_until("qb-table-name")
        page.keyboard.press("Enter")  # insert it (native button activation)
        # The click that Enter fires is debounced 250ms (QueryBrowser's
        # handleTableClick — see its comment: undebounced, a real double
        # click's own preceding click/click/dblclick sequence corrupted the
        # "insert SELECT * on an empty buffer" check), so the insert has not
        # landed the instant Enter returns.
        page.wait_for_timeout(400)
        record("keyboard-only (Tab focus order + Enter activation) expands the tree and inserts a name",
               UI_TABLE in editor_text(page),
               f"editor={editor_text(page)!r} after-1st-tab={landed_disclosure} "
               f"after-2nd-tab={landed_table_name}")
        page.fill(".qb-filter", "")

        # ==================== Query Browser additions (B-G, 1.29.0) ====================
        # A ran much earlier (right after fixture setup) — see the comment
        # there on why. Written against Postgres_Test specifically, per this
        # batch's own scope — unlike the sections above, these are not
        # exercised per-dialect.
        print("  (Query Browser additions B-G...)")

        # ---- B: SQL completion ----
        page.goto(GATEWAY_URL + SPA_PATH + "?view=query&project=Template", wait_until="load", timeout=30000)
        page.get_by_label("Datasource").select_option(DATASOURCE)
        page.wait_for_selector(".qb-table-name", timeout=15000)
        # Completion offers only the default schema's tables bare; on MSSQL
        # UI_TABLE lives in QB_SCHEMA, so it is reached through "qb.".
        prefix = UI_TABLE_QUALIFIED[:len(UI_TABLE_QUALIFIED) - 3]
        set_editor_text(page, f"SELECT * FROM {prefix}")
        # Ask explicitly: whether the popup opens by itself depends on typing
        # speed against the namespace build, which is not what this checks.
        page.keyboard.press("Control+Space")
        page.wait_for_selector(".cm-tooltip-autocomplete", timeout=5000)
        labels = page.locator(".cm-completionLabel").all_inner_texts()
        record("B: typing a table prefix offers the table in the completion popup",
               UI_TABLE in labels, labels)
        page.keyboard.press("Escape")

        # A mixed-case name's INSERTED text, not just its label — proves the
        # namespace handed lang-sql the RAW name and let IT quote on insert
        # (MEDIUM 3 of the review), the same way A's click-insert already
        # does via qualifiedTableName, but through the completion path.
        # MIXED_TABLE itself was created back at the top, alongside NEW_SCHEMA
        # — same cache-freshness reason (see the comment there); creating it
        # here instead raced SdkDbSchema's 300 s tables cache, which had
        # already been warmed (without it) by the checks above.
        if DIALECT == "postgres":
            try:
                page.goto(GATEWAY_URL + SPA_PATH + "?view=query&project=Template",
                          wait_until="load", timeout=30000)
                page.get_by_label("Datasource").select_option(DATASOURCE)
                page.wait_for_selector(".qb-table-name", timeout=15000)
                set_editor_text(page, f"SELECT * FROM {MIXED_TABLE[:-3]}")
                page.wait_for_selector(".cm-tooltip-autocomplete", timeout=5000)
                page.locator(".cm-completionLabel", has_text=MIXED_TABLE).first.click()
                record("B: accepting a completion for a mixed-case table inserts it QUOTED",
                       editor_text(page).strip() == f'SELECT * FROM "{MIXED_TABLE}"', editor_text(page))
            finally:
                run_sql(page, csrf, f'DROP TABLE IF EXISTS "{MIXED_TABLE}"')
        else:
            record("B: accepting a completion for a mixed-case table inserts it QUOTED",
                   None, f"SKIPPED on {DIALECT}")

        # ---- C: Save as Named Query ----
        saved_marker = f"validate-qb-{RUN_TOKEN}"
        saved_sql = f"SELECT '{saved_marker}' AS marker"
        saved_path = f"ValidateQB/Saved_{RUN_TOKEN}"
        set_editor_text(page, saved_sql)
        page.click("button:has-text('Save as Named Query')")
        page.wait_for_selector("#save-nq-path", timeout=10000)
        page.fill("#save-nq-path", saved_path)
        # A non-default type — proves the CHOSEN type reaches disk in the one
        # write, not just whatever the dialog happens to default to.
        page.select_option("#save-nq-type", "ScalarQuery")
        page.wait_for_timeout(400)  # let the existing-path check against the listing settle
        # Scoped to the dialog — the toolbar's own "Save as Named Query…"
        # button (still in the DOM behind the modal) also matches "Save".
        page.locator("[role='dialog'] button:has-text('Save')").click()
        page.wait_for_selector("text=/Saved as/", timeout=10000)
        record("C: the dialog confirms the save", True, "")

        disk_sql = f"{PROJECTS_DIR}/Template/ignition/named-query/{saved_path}/query.sql"
        raw = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", f"cat {disk_sql}"],
                              capture_output=True, text=True, timeout=30)
        record("C: the named query's SQL on disk matches exactly what was typed",
               raw.stdout == saved_sql, repr(raw.stdout))

        disk_resource = f"{PROJECTS_DIR}/Template/ignition/named-query/{saved_path}/resource.json"
        resource = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", f"cat {disk_resource}"],
                                   capture_output=True, text=True, timeout=30)
        record("C: the saved query's datasource is recorded on disk",
               f'"database":"{DATASOURCE}"' in resource.stdout.replace(" ", ""),
               resource.stdout[:400])

        encoded_saved_path = urllib.parse.quote(saved_path, safe="")
        settings = call(page, f"api/named-queries/settings/{encoded_saved_path}?project=Template")
        saved_type = ((settings["json"] or {}).get("settings") or {}).get("type")
        record("C: the CHOSEN query type (not just the sql) reached disk in one write",
               saved_type == "ScalarQuery", saved_type)
        base_sig = (settings["json"] or {}).get("signature")
        deleted = call(page, f"api/named-queries/content/{encoded_saved_path}?project=Template",
                       "DELETE", None, csrf, extra_headers={"If-Match": base_sig} if base_sig else None)
        record("C: the saved query is deleted afterward", deleted["status"] == 200, json.dumps(deleted.get("json")))

        # ---- D: results grid ----
        D_TABLE = f"qb_d_probe_{RUN_TOKEN}"
        run_sql(page, csrf, f"DROP TABLE IF EXISTS {D_TABLE}")
        run_sql(page, csrf, f"CREATE TABLE {D_TABLE} (n int, note text)")
        run_sql(page, csrf, f"INSERT INTO {D_TABLE} VALUES (3,'charlie'),(1,'alpha'),(2,'bravo')")
        try:
            set_editor_text(page, f"SELECT n, note FROM {D_TABLE}")
            page.click(".qb-toolbar button.primary")
            page.wait_for_selector(".qb-table td", timeout=15000)

            page.locator(".qb-table th button", has_text=re.compile(r"^n \(")).first.click()
            page.wait_for_timeout(300)
            cells = page.locator(".qb-table tbody tr td:nth-child(1)").all_inner_texts()
            record("D: clicking a column header sorts ascending", cells == ["1", "2", "3"], cells)

            page.locator(".qb-table th button", has_text=re.compile(r"^n \(")).first.click()
            page.wait_for_timeout(300)
            cells = page.locator(".qb-table tbody tr td:nth-child(1)").all_inner_texts()
            record("D: clicking it again sorts descending", cells == ["3", "2", "1"], cells)

            page.locator(".qb-table th button", has_text=re.compile(r"^n \(")).first.click()
            page.wait_for_timeout(300)
            record("D: a third click turns sorting off (aria-sort cleared)",
                   page.locator("th[aria-sort]").count() == 0, "")

            page.fill(".qb-result-filter", "bravo")
            page.wait_for_timeout(300)
            caption = page.locator(".qb-result-caption").inner_text()
            record("D: the filter box narrows rows and reports 'n of m rows'",
                   caption.startswith("1 of 3"), caption)
            page.fill(".qb-result-filter", "")
            page.wait_for_timeout(200)

            page.click("text=alpha")
            page.wait_for_selector("[role='dialog']", timeout=5000)
            viewer_text = page.locator(".qb-cellviewer-text").inner_text()
            record("D: the cell viewer shows the full value", viewer_text == "alpha", viewer_text)
            page.click(".qb-cellviewer button:has-text('Close')")
        finally:
            run_sql(page, csrf, f"DROP TABLE IF EXISTS {D_TABLE}")

        # ---- E: auto-refresh ----
        E_TABLE = f"qb_e_probe_{RUN_TOKEN}"
        run_sql(page, csrf, f"DROP TABLE IF EXISTS {E_TABLE}")
        run_sql(page, csrf, f"CREATE TABLE {E_TABLE} (x int)")
        run_sql(page, csrf, f"INSERT INTO {E_TABLE} VALUES (1)")
        try:
            set_editor_text(page, now_ts_sql())
            page.click(".qb-toolbar button.primary")
            # NOT wait_for_selector(".qb-table td") — D's own probe table is
            # still on screen at this point, so that selector would resolve
            # against STALE content instead of waiting for this run.
            # wait_for_run_to_finish sidesteps that: it reads the Run
            # button's OWN busy state, which is per-run regardless of what
            # table is currently showing.
            wait_for_run_to_finish(page)
            first_ts = page.locator(".qb-table td").first.inner_text()

            # The NEWEST entry's id, not the total count — the count alone
            # cannot prove anything once history is already at its cap
            # (the "history is capped at maxRuns" check above deliberately
            # drives it there): adding one more entry at the cap still
            # reports the same total, since the oldest is pruned.
            hist_before = call(page, "api/db-queries/history", "GET")
            newest_id_before = ((hist_before["json"] or {}).get("runs") or [{}])[0].get("id")

            page.get_by_label("Auto-refresh").select_option("5")
            page.wait_for_timeout(6500)
            second_ts = page.locator(".qb-table td").first.inner_text()
            record("E: auto-refresh reruns the last executed SQL at the chosen interval",
                   first_ts != "" and second_ts != first_ts, f"{first_ts!r} -> {second_ts!r}")

            hist_after = call(page, "api/db-queries/history", "GET")
            newest_id_after = ((hist_after["json"] or {}).get("runs") or [{}])[0].get("id")
            record("E: an auto-refresh run does not add a history entry (recordHistory:false)",
                   newest_id_after == newest_id_before,
                   f"newest before={newest_id_before} after={newest_id_after}")

            page.get_by_label("Auto-refresh").select_option("0")
            page.wait_for_timeout(300)

            set_editor_text(page, f"UPDATE {E_TABLE} SET x = x")
            page.click(".qb-toolbar button.primary")
            page.wait_for_timeout(600)
            page.get_by_label("Auto-refresh").select_option("5")
            page.wait_for_timeout(300)
            reason_shown = page.locator(".qb-autorefresh-note").count() > 0
            record("E: auto-refresh refuses to enable after a run that included an update",
                   reason_shown and page.get_by_label("Auto-refresh").input_value() == "0",
                   page.locator(".qb-autorefresh-note").inner_text() if reason_shown else "no reason shown")
        finally:
            page.get_by_label("Auto-refresh").select_option("0")
            run_sql(page, csrf, f"DROP TABLE IF EXISTS {E_TABLE}")

        # ---- E: the readOnly hint auto-refresh sends actually blocks a write ----
        # A plain DELETE and a RETURNING-shaped one that LOOKS like a result
        # set to the client's own eligibility check (every result was a
        # result set) — the second is exactly the shape the client-side
        # check alone cannot catch, which is why the server also enforces a
        # read-only hint (best-effort, Postgres honours it) rather than
        # relying on the client's own book-keeping alone.
        if DIALECT == "postgres":
            RO_TABLE = f"qb_ro_probe_{RUN_TOKEN}"
            run_sql(page, csrf, f"DROP TABLE IF EXISTS {RO_TABLE}")
            run_sql(page, csrf, f"CREATE TABLE {RO_TABLE} (id int)")
            try:
                run_sql(page, csrf, f"INSERT INTO {RO_TABLE} VALUES (1)")
                r = run_sql(page, csrf, f"DELETE FROM {RO_TABLE} WHERE id = 1", read_only=True)
                count_after = run_sql(page, csrf, f"SELECT count(*) FROM {RO_TABLE}")
                still_there = ((count_after.get("json") or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
                record("E: readOnly:true refuses a plain DELETE rather than run it",
                       (r.get("json") or {}).get("ok") is False and str(still_there) == "1",
                       json.dumps(r.get("json")))

                r2 = run_sql(page, csrf,
                              f"WITH deleted AS (DELETE FROM {RO_TABLE} WHERE id = 1 RETURNING *) "
                              f"SELECT * FROM deleted", read_only=True)
                count_after2 = run_sql(page, csrf, f"SELECT count(*) FROM {RO_TABLE}")
                still_there2 = ((count_after2.get("json") or {}).get("results")
                                or [{}])[0].get("rows", [[None]])[0][0]
                record("E: readOnly:true refuses a CTE-wrapped DELETE...RETURNING too "
                       "(it LOOKS like a result set)",
                       (r2.get("json") or {}).get("ok") is False and str(still_there2) == "1",
                       json.dumps(r2.get("json")))

                r3 = run_sql(page, csrf, f"DELETE FROM {RO_TABLE} WHERE id = 1")
                count_after3 = run_sql(page, csrf, f"SELECT count(*) FROM {RO_TABLE}")
                gone = ((count_after3.get("json") or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
                record("E: the SAME delete succeeds without the readOnly hint — it is a hint, not a lockout",
                       (r3.get("json") or {}).get("ok") is True and str(gone) == "0",
                       json.dumps(r3.get("json")))
            finally:
                run_sql(page, csrf, f"DROP TABLE IF EXISTS {RO_TABLE}")
        elif DIALECT in ("mysql", "mssql"):
            # Neither MariaDB's nor MSSQL's driver actually REFUSES the write
            # the way Postgres's does — setReadOnly is a no-op on both (not
            # just MSSQL, confirmed live), so the DELETE reports ok:true with
            # a real affected count. The safety property is the same one
            # Postgres gets a different way: rollBackIfOpen undoes it before
            # the connection goes back to the pool, so the row is still there.
            RO_TABLE = f"qb_ro_probe_{RUN_TOKEN}"
            run_sql(page, csrf, f"DROP TABLE IF EXISTS {RO_TABLE}")
            run_sql(page, csrf, f"CREATE TABLE {RO_TABLE} (id int)")
            try:
                run_sql(page, csrf, f"INSERT INTO {RO_TABLE} VALUES (1)")
                r = run_sql(page, csrf, f"DELETE FROM {RO_TABLE} WHERE id = 1", read_only=True)
                count_after = run_sql(page, csrf, f"SELECT count(*) FROM {RO_TABLE}")
                still_there = ((count_after.get("json") or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
                record(f"E: readOnly:true reports the DELETE as ok (setReadOnly is a no-op on {DIALECT}), "
                       "but the rollback genuinely undoes it",
                       (r.get("json") or {}).get("ok") is True and str(still_there) == "1",
                       json.dumps(r.get("json")))

                if DIALECT == "mssql":
                    # NOCOUNT suppresses the affected-count result entirely
                    # (results:[]) — the safety property must not depend on
                    # that result shape being present.
                    run_sql(page, csrf, f"DELETE FROM {RO_TABLE} WHERE id = 1")  # clean slate, no hint
                    run_sql(page, csrf, f"INSERT INTO {RO_TABLE} VALUES (1)")
                    r_nc = run_sql(page, csrf, f"SET NOCOUNT ON; DELETE FROM {RO_TABLE} WHERE id = 1",
                                   read_only=True)
                    count_nc = run_sql(page, csrf, f"SELECT count(*) FROM {RO_TABLE}")
                    still_nc = ((count_nc.get("json") or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
                    record("E: SET NOCOUNT ON; DELETE with readOnly:true is still rolled back "
                           "(safety doesn't depend on an affected-count result being present)",
                           (r_nc.get("json") or {}).get("ok") is True and str(still_nc) == "1",
                           json.dumps(r_nc.get("json")))

                r3 = run_sql(page, csrf, f"DELETE FROM {RO_TABLE} WHERE id = 1")
                count_after3 = run_sql(page, csrf, f"SELECT count(*) FROM {RO_TABLE}")
                gone = ((count_after3.get("json") or {}).get("results") or [{}])[0].get("rows", [[None]])[0][0]
                record("E: the SAME delete succeeds without the readOnly hint — it is a hint, not a lockout",
                       (r3.get("json") or {}).get("ok") is True and str(gone) == "0",
                       json.dumps(r3.get("json")))
            finally:
                run_sql(page, csrf, f"DROP TABLE IF EXISTS {RO_TABLE}")
        else:
            record("E: readOnly hint blocks a write (Postgres-specific probe)",
                   None, f"SKIPPED on {DIALECT}")

        # ---- F: CSV export ----
        F_TABLE = f"qb_f_probe_{RUN_TOKEN}"
        run_sql(page, csrf, f"DROP TABLE IF EXISTS {F_TABLE}")
        run_sql(page, csrf, f"CREATE TABLE {F_TABLE} (n int, note text)")
        run_sql(page, csrf, f"""INSERT INTO {F_TABLE} VALUES (1, 'a,b'), (2, 'say "hi"'), (3, NULL)""")
        try:
            set_editor_text(page, f"SELECT n, note FROM {F_TABLE} ORDER BY n")
            page.click(".qb-toolbar button.primary")
            page.wait_for_selector(".qb-table td", timeout=15000)
            with page.expect_download() as dl_info:
                page.click("button:has-text('Export CSV')")
            download = dl_info.value
            suggested = download.suggested_filename
            record("F: the CSV filename follows <datasource>-<yyyyMMdd-HHmm>.csv",
                   re.match(rf"^{re.escape(DATASOURCE)}-\d{{8}}-\d{{4}}\.csv$", suggested) is not None,
                   suggested)
            csv_path = os.path.join(tempfile.gettempdir(), f"qb_export_{RUN_TOKEN}.csv")
            download.save_as(csv_path)
            with open(csv_path, "rb") as fh:
                content = fh.read()
            record("F: the CSV starts with a UTF-8 BOM", content[:3] == b"\xef\xbb\xbf", content[:3])
            text = content.decode("utf-8-sig")
            lines = text.split("\r\n")
            record("F: CRLF line endings", text.count("\r\n") >= 3, repr(text[:60]))
            record("F: a field containing a comma is quoted", len(lines) > 1 and '"a,b"' in lines[1], lines)
            record("F: an embedded quote is doubled", 'say ""hi""' in text, text)
            record("F: a null becomes an empty field", len(lines) > 3 and lines[3] == "3,", lines)
            os.remove(csv_path)
        finally:
            run_sql(page, csrf, f"DROP TABLE IF EXISTS {F_TABLE}")

        # ---- G: run the statement under the cursor ----
        # set_editor_text leaves the cursor at the very end of the buffer —
        # right AFTER the final ';'. Under the dialect-aware splitter's "a
        # cursor right after ; on the same line still selects the statement
        # just finished" rule (MEDIUM 8 of the review), that now resolves
        # straight to "SELECT 202" with no ArrowLeft workaround needed.
        set_editor_text(page, "SELECT 101;\n\nSELECT 202;")
        page.click("button:has-text('Run statement')")
        wait_for_run_to_finish(page)
        hist_g = call(page, "api/db-queries/history", "GET")
        newest_g = (hist_g["json"].get("runs") or [{}])[0]
        record("G: Run statement runs only the statement containing the cursor",
               newest_g.get("sql") == "SELECT 202", json.dumps(newest_g))
        record("G: the cursor right after the ; it just typed runs the statement just finished, "
               "with no need to step back first",
               newest_g.get("sql") == "SELECT 202", "")

        # Clicking "Run statement" moved DOM focus onto that button, so a bare
        # ArrowUp now would reach the button, not the editor. Click back into
        # the editor, then Control+End resets to a KNOWN absolute position
        # (the click itself can land anywhere) before navigating from there.
        page.click(".qb-editor .cm-content")
        page.keyboard.press("Control+End")
        page.keyboard.press("ArrowLeft")  # inside "SELECT 202" again
        page.keyboard.press("ArrowUp")  # up one line, onto the blank line between the two statements
        page.click("button:has-text('Run statement')")
        page.wait_for_timeout(400)  # a refusal shows no run at all — nothing to wait_for_run_to_finish on
        record("G: the cursor on a blank line between statements runs nothing and says so",
               page.locator("text=/nothing to run/i").count() > 0, "")

        set_editor_text(page, "SELECT 'unterminated")
        page.click("button:has-text('Run statement')")
        page.wait_for_timeout(400)
        record("G: an unterminated string refuses with a message rather than guessing a statement",
               page.locator("text=/unterminated/i").count() > 0, "")

        # ---- Splitter: the handful of vendor-specific tokens (1.29.0) ----
        if DIALECT == "mysql":
            # A backslash-escaped quote inside a single-quoted string must not
            # end the string early and split the statement there.
            set_editor_text(page, "SELECT 'it\\'s ok' AS x;\nSELECT 2 AS y;")
            page.keyboard.press("Control+Home")
            page.click("button:has-text('Run statement')")
            wait_for_run_to_finish(page)
            hist_esc = call(page, "api/db-queries/history", "GET")
            newest_esc = (hist_esc["json"].get("runs") or [{}])[0]
            record("Splitter: a backslash-escaped quote (\\') doesn't end the string/statement early",
                   newest_esc.get("ok") is True and "it" in newest_esc.get("sql", "")
                   and "AS x" in newest_esc.get("sql", ""), json.dumps(newest_esc))

            # A '#' comment must not be read as literal SQL nor confuse where
            # the statement ends.
            set_editor_text(page, "SELECT 1 AS a # trailing hash comment\n;\nSELECT 2 AS b;")
            page.keyboard.press("Control+Home")
            page.click("button:has-text('Run statement')")
            wait_for_run_to_finish(page)
            hist_hash = call(page, "api/db-queries/history", "GET")
            newest_hash = (hist_hash["json"].get("runs") or [{}])[0]
            record("Splitter: a '#' comment on the statement's own line does not break it",
                   newest_hash.get("ok") is True, json.dumps(newest_hash))
        elif DIALECT == "mssql":
            # GO is a CLIENT-side batch separator, never sent to the server —
            # "Run statement" with the cursor on the first line must run only
            # up to the GO, not the whole buffer as one batch.
            set_editor_text(page, "SELECT 1 AS a\nGO\nSELECT 2 AS b\nGO")
            page.keyboard.press("Control+Home")
            page.click("button:has-text('Run statement')")
            wait_for_run_to_finish(page)
            hist_go = call(page, "api/db-queries/history", "GET")
            newest_go = (hist_go["json"].get("runs") or [{}])[0]
            record("Splitter: GO ends a batch — 'Run statement' runs only the statement before it",
                   newest_go.get("ok") is True and newest_go.get("sql", "").strip() == "SELECT 1 AS a",
                   json.dumps(newest_go))

        # ---- Clear SQL (1.29.0) ----
        page.goto(GATEWAY_URL + SPA_PATH + "?view=query&project=Template", wait_until="load", timeout=30000)
        page.get_by_label("Datasource").select_option(DATASOURCE)
        page.wait_for_selector(".qb-table-name", timeout=15000)
        clear_sql_marker = f"SELECT 'clear-sql-{RUN_TOKEN}'"
        set_editor_text(page, clear_sql_marker)
        page.wait_for_timeout(150)  # the autosave listener is synchronous; this just lets input settle
        page.reload(wait_until="load")
        page.wait_for_selector(".qb-editor .cm-content", timeout=15000)
        record("Clear SQL: the buffer survives a reload right after typing (no debounce loses it)",
               clear_sql_marker in editor_text(page), editor_text(page))

        page.click("button:has-text('Clear SQL')")
        page.wait_for_timeout(150)
        page.reload(wait_until="load")
        page.wait_for_selector(".qb-editor .cm-content", timeout=15000)
        record("Clear SQL: empties the editor and forgets the saved buffer across a reload",
               editor_text(page).strip() == "", repr(editor_text(page)))

        # ==================== Script Console: project picker + buffer (1.29.0) ====================
        print("  (Script Console: project picker, buffer autosave, Clear script...)")

        projects_resp = call(page, "api/projects")
        all_projects = [p.get("name") for p in (projects_resp.get("json") or {}).get("projects", [])]
        other_project = next((p for p in all_projects if p and p != "Template"), None)

        page.goto(GATEWAY_URL + SPA_PATH + "?view=console&project=Template", wait_until="load", timeout=30000)
        page.wait_for_selector(".console-editor .cm-content", timeout=15000)
        console_marker = f"validate-console-{RUN_TOKEN}"
        page.click(".console-editor .cm-content")
        page.keyboard.press("Control+a")
        page.keyboard.press("Delete")
        page.keyboard.type(f"print('{console_marker}')")
        page.wait_for_timeout(150)
        page.reload(wait_until="load")
        page.wait_for_selector(".console-editor .cm-content", timeout=15000)
        record("Console: the script survives a reload (shared buffer autosave)",
               console_marker in page.locator(".console-editor .cm-content").inner_text(), "")

        page.click("button:has-text('Clear script')")
        page.wait_for_timeout(150)
        page.reload(wait_until="load")
        page.wait_for_selector(".console-editor .cm-content", timeout=15000)
        cleared_text = page.locator(".console-editor .cm-content").inner_text()
        record("Console: Clear script resets to the starter text and forgets the saved buffer across a reload",
               console_marker not in cleared_text and "Runs on the Gateway" in cleared_text, cleared_text)

        if other_project:
            page.get_by_label("Project").select_option(other_project)
            page.click(".console-editor .cm-content")
            page.keyboard.press("Control+a")
            page.keyboard.press("Delete")
            page.keyboard.type("print(system.util.getProjectName())")
            page.click(".console-toolbar button.primary")
            wait_for_run_to_finish(page, selector=".console-toolbar button.primary")
            output_text = page.locator(".console-stdout").last.inner_text()
            record("Console: the picker's SELECTED project (not the IDE's) is what a run actually uses",
                   output_text.strip() == other_project, output_text)

            page.wait_for_timeout(150)
            page.reload(wait_until="load")
            page.wait_for_selector(".console-editor .cm-content", timeout=15000)
            record("Console: a reload keeps the picker's project selection",
                   page.get_by_label("Project").input_value() == other_project,
                   page.get_by_label("Project").input_value())
            record("Console: a reload keeps the buffer typed against that project",
                   "getProjectName" in page.locator(".console-editor .cm-content").inner_text(), "")
        else:
            record("Console: the project picker actually switches which project a run uses",
                   None, "SKIPPED — only one project (Template) is on this gateway")

        # ==================== History survives a restart ====================
        if CONTAINER:
            before_restart = call(page, "api/db-queries/history", "GET")
            newest_id_before = ((before_restart["json"] or {}).get("runs") or [{}])[0].get("id")

            print("  (restarting the test gateway container to prove history survives it...)")
            subprocess.run(["docker", "restart", CONTAINER], check=True, capture_output=True, timeout=60)

            running = False
            for _ in range(60):
                try:
                    # 200 arrives while the gateway is still STARTING; the login
                    # page is not served until it says RUNNING.
                    with urllib.request.urlopen(GATEWAY_URL + "/StatusPing", timeout=5) as resp:
                        if resp.status == 200 and b"RUNNING" in resp.read():
                            running = True
                            break
                except Exception:
                    pass
                time.sleep(2)
            record("the gateway comes back up after the restart", running,
                   "StatusPing never said RUNNING within 120s" if not running else "")

            if running:
                # A container restart drops the old WebUiSession. Modules are
                # still starting just after RUNNING, so give the login a few tries.
                for attempt in range(3):
                    try:
                        login(page)
                        break
                    except Exception:
                        if attempt == 2:
                            raise
                        time.sleep(15)
                after_restart = call(page, "api/db-queries/history", "GET")
                ids_after = [r.get("id") for r in (after_restart["json"] or {}).get("runs", [])]
                record("the newest history entry from before the restart is still there after it",
                       newest_id_before is not None and newest_id_before in ids_after,
                       f"before={newest_id_before} after has {len(ids_after)} entries")

                gate = subprocess.run(
                    [sys.executable, str(Path(__file__).parent / "deploy_gate.py")],
                    env=os.environ.copy(), capture_output=True, text=True, timeout=180)
                record("deploy_gate.py PASSes after the restart, proving the module came back cleanly",
                       gate.returncode == 0 and "PASS" in gate.stdout,
                       gate.stdout.strip().splitlines()[-1] if gate.stdout.strip() else gate.stderr[-300:])
        else:
            record("history survives a gateway restart", None,
                   "SKIPPED — config.local.json has no container_name")
            record("deploy_gate.py PASSes after the restart", None,
                   "SKIPPED — config.local.json has no container_name")

        browser.close()

    print()
    failed = [n for n, ok, _ in results if ok is False]
    skipped = [n for n, ok, _ in results if ok is None]
    print(f"{len(results) - len(failed) - len(skipped)} passed, {len(failed)} failed, "
          f"{len(skipped)} skipped, of {len(results)}")
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
