"""Shared, PROVEN gateway login for every validation/deploy script.

This is the exact sequence from install-and-verify.py that has worked across
19+ installs. Validation scripts MUST import this instead of re-deriving login —
half-working ad-hoc logins produce unauthenticated sessions, and an
unauthenticated SPA shows "Failed to list projects", which then gets
misdiagnosed as a rendering regression (this burned a full session on 10/07).

Usage (sync playwright, run under the toolbox venv which has playwright):

    from gateway_session import CONFIG, login, assert_authenticated
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(viewport={"width": 1600, "height": 1000}).new_page()
        login(page)
        session = assert_authenticated(page)   # raises if not really logged in
"""

import json
import os
from pathlib import Path

# Which gateway these scripts talk to. `SI_GATEWAY_CONFIG` points the whole
# toolchain at a chosen config without editing (or risking) `config.local.json`
# — that is how a disposable gateway is targeted, with throwaway credentials,
# and the real one is never opened.
#
# There is deliberately NO silent fallback to `config.local.json` — the SHARED
# gateway — when the variable is unset. Before 20/08/2026 there was one, and it
# meant a script run with a typo'd or forgotten `SI_GATEWAY_CONFIG` would just
# quietly authenticate against the shared gateway instead: for a read-only
# validator that is a wrong-gateway result that still looks plausible, and for
# anything that writes (a tag save, a resource write, an install) it is the
# same class of mistake `install-and-verify.py`'s own refusal exists for
# (17/08/2026 — see that script and RUNBOOK.md "Deploy"). Set
# `WD_ALLOW_LOCAL_CONFIG=1` to opt into `config.local.json` explicitly when
# that really is the intended target.
_chosen = os.environ.get("SI_GATEWAY_CONFIG")
if not _chosen and os.environ.get("WD_ALLOW_LOCAL_CONFIG") != "1":
    raise SystemExit(
        "REFUSING TO GUESS WHICH GATEWAY: SI_GATEWAY_CONFIG is not set.\n"
        "Every script under scripts/testing/ that imports gateway_session needs\n"
        "an explicit target — there is no silent fallback to config.local.json\n"
        "(the SHARED gateway) any more, because that fallback let a forgotten\n"
        "env var run real checks/writes against the wrong gateway without saying so.\n\n"
        "For the disposable dev gateway:\n"
        "  SI_GATEWAY_CONFIG=scripts/testing/config.devgw.json <command>\n\n"
        "To deliberately target the shared gateway via config.local.json:\n"
        "  WD_ALLOW_LOCAL_CONFIG=1 <command>"
    )
_CONFIG_PATH = Path(_chosen or (Path(__file__).parent / "config.local.json"))

if not _CONFIG_PATH.exists():
    # This is the first thing a new checkout hits, and a bare FileNotFoundError
    # traceback here reads like the scripts are broken rather than unconfigured.
    raise SystemExit(
        f"Missing {_CONFIG_PATH.name} — the test-gateway config every script here reads.\n"
        f"  cp {_CONFIG_PATH.name}.template {_CONFIG_PATH.name}\n"
        f"then fill it in (see docs/SETUP.md). It is gitignored because it holds a\n"
        f"gateway password: never commit it, and never paste its contents anywhere.\n"
        f"Expected at: {_CONFIG_PATH}"
    )

CONFIG = json.loads(_CONFIG_PATH.read_text())

_REQUIRED = ("gateway_url", "username", "password")
_missing = [k for k in _REQUIRED if not CONFIG.get(k)]
if _missing:
    raise SystemExit(
        f"{_CONFIG_PATH.name} is missing required key(s): {', '.join(_missing)}.\n"
        f"Compare it against {_CONFIG_PATH.name}.template."
    )

GATEWAY_URL = CONFIG["gateway_url"].rstrip("/")

LOGIN_LINK = (
    "a.login-link, a[href*='login'], button.login-button, #login-button, "
    "[data-testid='login'], nav a:has-text('Login')"
)
USER_FIELD = "input[name='j_username'], input[name='username'], input[type='text']"
PASS_FIELD = "input[name='j_password'], input[name='password'], input[type='password']"
HOME_READY = ".home-page, .ia_homePage, [data-page='home'], nav"


def dismiss_quick_start(page) -> None:
    """Clear the Quick Start modal a FRESHLY commissioned 8.3 gateway shows.

    It is a full-page MUI modal (`[data-component="web-ui.quick-start-modal"]`)
    whose backdrop intercepts pointer events, so it blocks EVERY click on the
    page beneath — including the login link itself. Playwright then reports a
    perfectly correct selector timing out on an actionability check, and names
    the backdrop rather than the modal, so the cause does not read as "a dialog
    is open". Discovered 14/08/2026 on the first install onto a freshly
    commissioned gateway.

    A no-op on any gateway that has already been through it once.
    """
    sel = '[data-component="web-ui.quick-start-modal"]'
    try:
        # WAIT for it rather than testing once. The modal renders a moment AFTER
        # the load event, so an immediate `count()` returns 0, the dismissal
        # returns having done nothing, and the modal then appears and blocks the
        # very next click — which is exactly how this failed the first time.
        page.wait_for_selector(sel, state="visible", timeout=6000)
    except Exception:
        return  # no modal on this gateway: already dismissed, or not a fresh one
    try:
        # "No thanks, I'd like to start from scratch" — the option that does NOT
        # install sample tags, a device simulator and an alarm journal onto the
        # gateway under test.
        page.locator(f'{sel} button[data-label^="No thanks"]').first.click(timeout=5000)
        page.wait_for_selector(sel, state="detached", timeout=10000)
    except Exception:
        # Never fail login because of a dialog that may not be there.
        pass


def login(page) -> None:
    """Log in via the gateway web UI. Raises on failure — never continue unauthenticated."""
    page.goto(GATEWAY_URL + "/", wait_until="load", timeout=30000)
    dismiss_quick_start(page)
    # Wait for the login link, and reload once if it does not arrive.
    #
    # The gateway's own web UI is a SPA that boots AFTER the `load` event, and
    # straight after a module install — which restarts the gateway — the nav can
    # take longer to render than a single wait allows. The symptom is a
    # perfectly correct selector timing out, which reads like a broken locator
    # rather than a slow boot, and it cost a retry of the deploy gate after
    # every single install until this was added (01/09/2026).
    try:
        page.wait_for_selector(LOGIN_LINK, state="visible", timeout=20000)
    except Exception:
        page.reload(wait_until="load", timeout=30000)
        dismiss_quick_start(page)
        page.wait_for_selector(LOGIN_LINK, state="visible", timeout=30000)
    page.click(LOGIN_LINK, timeout=10000)
    page.wait_for_selector(USER_FIELD, timeout=10000)
    page.fill(USER_FIELD, CONFIG["username"])
    page.click("text='CONTINUE'", timeout=10000)
    page.wait_for_selector(PASS_FIELD, timeout=10000)
    page.fill(PASS_FIELD, CONFIG["password"])
    page.click("text='CONTINUE'", timeout=10000)
    page.wait_for_selector(HOME_READY, timeout=15000)


def assert_authenticated(page) -> dict:
    """Prove the session is real BEFORE judging any render or API result.

    Returns the session dict ({username, writable, csrfToken, ...}).
    Raises RuntimeError if unauthenticated — a "Failed to list projects" UI in an
    unauthenticated session is expected behaviour, not a bug.
    """
    session = page.evaluate(
        "async () => { const r = await fetch('/data/scriptide/api/auth/session',"
        " {credentials: 'include'}); return await r.json(); }"
    )
    if not session.get("authenticated"):
        raise RuntimeError(
            f"NOT AUTHENTICATED ({session}) — every subsequent 401/'Failed to list' "
            "is a login problem, not a module bug. Fix login first."
        )
    return session
