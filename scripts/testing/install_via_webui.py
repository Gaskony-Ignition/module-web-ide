#!/usr/bin/env python3
"""Install a signed .modl through the gateway's OWN web UI. No other repo needed.

Why this exists: `install-and-verify.py` drives its install through a playbook
engine that lives in a separate, private repo, so it cannot run from a clean
clone — the one thing in this repo that was not self-contained (13/08/2026).
This does the same job with nothing but Playwright and the gateway's own
Config > Modules page, which is the path `docs/SETUP.md` already documents for
a human.

It does NOT decide whether the install worked. `deploy_gate.py` does that, and
this script ends by saying so rather than implying success.

Target gateway comes from `config.local.json`, or from whatever
`SI_GATEWAY_CONFIG` points at — use that to install onto a different gateway
instead of the usual one.

Usage:
    SI_GATEWAY_CONFIG=/path/to/config.json \
    PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
      scripts/testing/.venv/bin/python scripts/testing/install_via_webui.py [path/to/.modl]

With no argument it installs the highest-versioned signed .modl in the config's
`module_folder`.
"""
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from gateway_session import CONFIG, GATEWAY_URL, dismiss_quick_start, login  # noqa: E402

MODULES_PAGE = GATEWAY_URL + "/app/platform/system/modules"


def newest_signed_modl(folder: Path) -> Path:
    candidates = [p for p in folder.glob("WebIDE-*.modl") if "unsigned" not in p.name.lower()]
    if not candidates:
        sys.exit(f"No signed WebIDE-*.modl in {folder}. Run ./gradlew clean build first.")

    def key(p: Path):
        m = re.search(r"WebIDE-([\d.]+)\.modl$", p.name)
        return tuple(int(x) for x in m.group(1).split(".")) if m else (0,)

    return sorted(candidates, key=key)[-1]


def install(page, modl: Path) -> None:
    """Drive Config > Modules > Install or Upgrade a Module.

    The flow, as it actually is on 8.3.8 — every step keyed on `data-label`,
    which is stable, rather than on visible text:

      1. "Install or Upgrade a Module" opens a dialog offering "Choose File..."
         with "Install Module" DISABLED until a file is chosen.
      2. Setting the file input enables "Install Module".
      3. Clicking it does not install: it opens a "Module Certificate" dialog,
         because this project signs with its own self-signed certificate
         ("Gaskony Module Signing"). That prompt is expected and is NOT the same
         thing as an unsigned module, which this project never installs.
      4. "Accept Certificate" is DISABLED until the "I accept the module
         certificate" checkbox is ticked.
    """
    page.goto(MODULES_PAGE, wait_until="domcontentloaded", timeout=30000)
    time.sleep(2)
    dismiss_quick_start(page)

    trigger = page.get_by_role("button", name=re.compile(r"install|upgrade", re.I))
    if not trigger.count():
        sys.exit("No 'Install or Upgrade a Module' control on the Modules page.")
    trigger.first.click()
    page.wait_for_selector('button[data-label="Install Module"]', timeout=15000)

    page.set_input_files("input[type='file']", str(modl))
    print(f"Chose {modl.name}")
    install_btn = page.locator('button[data-label="Install Module"]').first
    for _ in range(20):
        if install_btn.is_enabled():
            break
        time.sleep(0.5)
    install_btn.click()

    # The certificate step. Absent only if this gateway has already accepted
    # this certificate, so treat it as optional rather than required.
    try:
        page.wait_for_selector('button[data-label="Accept Certificate"]', timeout=10000)
    except Exception:
        print("No certificate prompt (already trusted on this gateway).")
        time.sleep(5)
        return

    dialog = page.locator('[role=dialog], .MuiModal-root').last
    checkbox = dialog.locator("input[type='checkbox']").first
    if checkbox.count():
        checkbox.check(force=True)
    accept = page.locator('button[data-label="Accept Certificate"]').first
    for _ in range(20):
        if accept.is_enabled():
            break
        time.sleep(0.5)
    if not accept.is_enabled():
        sys.exit("'Accept Certificate' never enabled — the acceptance checkbox did not tick.")
    accept.click()
    print("Accepted the module certificate (self-signed, as expected).")
    time.sleep(8)


def restart_if_pending(page) -> bool:
    """Apply a staged module install via the gateway's OWN restart banner.

    A first install lands INACTIVE/PENDING RESTART: on 8.3 a staged module op is
    only committed by the gateway's module manager at its own restart. A
    `docker restart` does NOT apply it and has previously desynced staging state
    badly enough to need a UI-level uninstall, so this always goes through the
    banner.

    Returns True if a restart was triggered.

    **The banner starts COLLAPSED** (fixed 16/08/2026). On 8.3.8 it is a small
    warning-triangle button pinned to the bottom-right of the page —
    `#expand-restart-required-banner` — and the "Restart Gateway" button does
    not exist in the DOM until it is expanded. This function previously looked
    only for a button named "Restart Gateway", found none, and returned False
    while reporting nothing: the install *had* staged correctly
    (`modules.json` carried `upgradeVersion` 0.67.0 and a `pending-upgrade/`
    file) and the gateway simply kept serving the old module. The deploy gate
    caught it, which is what the gate is for — but the failure looked like a bad
    install for three runs. Selectors below match the toolbox playbook's
    `gateway/gateway_restart.yaml`, which had them right all along.

    NOTE: only ever call this against a gateway you own. On a shared one a
    restart interrupts whoever else is using it, which is why the module's house
    rules forbid it there — use a disposable gateway of your own.
    """
    expander = page.locator("button#expand-restart-required-banner")
    if expander.count():
        expander.first.click()
        time.sleep(1.5)

    banner = page.locator(
        'button[data-label="Restart Gateway"], '
        '#restart-required-banner button:has-text("Restart Gateway"), '
        'button:has-text("Restart Gateway")'
    )
    if not banner.count():
        print("No pending restart (no banner) — nothing staged, or already applied.")
        return False
    print("Module is staged (PENDING RESTART) — restarting the gateway via its banner.")
    banner.first.click()
    time.sleep(1.5)

    # The confirm modal's button stays disabled until an "I understand the
    # risks" checkbox is ticked. Its own id is lower-cased with a space in it.
    try:
        for sel in (
            '#confirm-restart-modal label:has-text("I understand the risks")',
            'label[data-label="I understand the risks and would like to proceed."]',
            "[role=dialog] input[type='checkbox']",
        ):
            box = page.locator(sel)
            if box.count():
                box.first.click(force=True)
                break
        time.sleep(0.8)
        confirm = page.locator('button[id="restart gateway-button"]')
        if confirm.count():
            confirm.first.click()
        else:
            dialog = page.locator("[role=dialog], .MuiModal-root").last
            for name in (r"^restart$", r"^confirm$", r"^restart gateway$", r"^yes$"):
                btn = dialog.get_by_role("button", name=re.compile(name, re.I))
                if btn.count() and btn.first.is_enabled():
                    btn.first.click()
                    break
    except Exception as exc:
        print(f"WARNING: could not confirm the restart dialog ({exc}).")
    return True


def wait_for_running(gateway_url: str, timeout_s: int = 300) -> bool:
    """Poll StatusPing until the gateway reports RUNNING again."""
    from urllib.request import urlopen

    deadline = time.time() + timeout_s
    print(f"Waiting for the gateway to come back (up to {timeout_s}s)...")
    while time.time() < deadline:
        try:
            with urlopen(gateway_url + "/StatusPing", timeout=5) as r:
                if b"RUNNING" in r.read():
                    time.sleep(5)
                    print("Gateway is RUNNING.")
                    return True
        except Exception:
            pass
        time.sleep(5)
    print("WARNING: gateway did not report RUNNING in time.")
    return False


def main() -> None:
    from playwright.sync_api import sync_playwright

    modl = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else newest_signed_modl(
        Path(CONFIG["module_folder"])
    )
    if not modl.exists():
        sys.exit(f"No such file: {modl}")
    print(f"Installing {modl.name} onto {GATEWAY_URL}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1600, "height": 1000}).new_page()
        login(page)
        dismiss_quick_start(page)
        install(page, modl)
        time.sleep(5)
        page.reload(wait_until="domcontentloaded")
        time.sleep(3)
        restarted = restart_if_pending(page)
        browser.close()

    if restarted:
        wait_for_running(GATEWAY_URL)

    print(
        "\nInstall attempted. This script does NOT decide whether it worked —\n"
        "run deploy_gate.py, which compares the SERVED bundle hash and module\n"
        "version against the build. An install that 'succeeds' while the gateway\n"
        "keeps serving the old module is a real failure mode here."
    )


if __name__ == "__main__":
    main()
