"""Measure contrast on the REAL painted elements, per theme, in the browser."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gateway_session import CONFIG, GATEWAY_URL, login
from playwright.sync_api import sync_playwright
SPA = CONFIG.get("spa_path", "/data/scriptide/")
OUT = os.environ.get("SI_SHOT_DIR", "/tmp")

MEASURE = """() => {
  const lum = (c) => {
    const [r,g,b] = c;
    const f = (v) => { v/=255; return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);
  };
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if(!m) return null;
    const p = m[1].split(',').map(Number); return p.length>=3 ? p.slice(0,3) : null; };
  // Composite the alpha, do not discard it.
  //
  // This walked up until backgroundColor was not fully transparent and then
  // took its RGB. Correct while every surface was opaque hex, wrong from
  // 1.8.0: the glass packs paint chrome as rgba(255,255,255,0.06), whose RGB
  // is PURE WHITE. The sweep read a 6% film as a white background and called
  // both aurora themes illegible at 1.69:1 when the composited surface is dark
  // and the real ratio is fine. A gate that cannot see alpha cannot measure a
  // translucent theme -- and would have had me revert a correct change.
  const alphaOf = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return 1; const q = m[1].split(',').map(Number);
    return q.length >= 4 ? q[3] : 1; };
  const bgOf = (el) => {
    const layers = [];
    let n = el;
    while (n) {
      const c = getComputedStyle(n).backgroundColor;
      const q = parse(c);
      const a = q ? alphaOf(c) : 0;
      if (q && a > 0) {
        layers.push([q, a]);
        if (a >= 0.999) break;      // opaque: nothing below can show through
      }
      n = n.parentElement;
    }
    if (!layers.length) return [255,255,255];
    let out = layers[layers.length-1][0];
    for (let i = layers.length-2; i >= 0; i--) {
      const [rgb, a] = layers[i];
      out = [0,1,2].map((k) => rgb[k]*a + out[k]*(1-a));
    }
    return out;
  };
  const ratio = (a,b) => { const la=lum(a), lb=lum(b);
    return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05); };
  const out = [];
  const sel = '.file-tree-item, .file-tree-header, .file-tree-package, .panel-tab, ' +
    '.tab-strip button, .config-label, .workspace-toolbar button, .rail-title, ' +
    '.outline-item, .console-output, .muted, .badge, .status-footer, .app-version, ' +
    // The FILLED primary button. Added 04/09/2026: its label was the literal
    // `#ffffff` from 1.1.0 to 1.10.0, so on `newsprint-night` (accent #e8e2d6,
    // paper) and `aurora-teal` (accent #1accbe) the Run button was white on
    // near-white and white on bright teal. Nothing here measured it, because
    // this sweep reads a colour off an element and a literal in a stylesheet is
    // not a token any theme can move.
    'button.primary, .button.primary';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const fg = parse(getComputedStyle(el).color);
    if (!fg) continue;
    out.push({ text: text.slice(0,28), cls: el.className.toString().slice(0,40),
               ratio: Math.round(ratio(fg, bgOf(el))*100)/100 });
  }
  // The activity bar, which has NO TEXT and was therefore invisible to the loop
  // above — `if (!text) continue` skipped every icon in it. From 1.11.0 that
  // strip can carry the pack's OWN rail colour (`finance-ledger` brands it navy
  // on a light page), so it is the one surface whose ink is computed against
  // something other than the page, and the one most in need of measuring.
  //
  // 3:1, not 4.5:1: these are icon strokes and a 3px marker, which is WCAG
  // 1.4.11's bar for non-text contrast. Measured on `color`, because every icon
  // here is an SVG drawn in `currentColor`.
  for (const el of document.querySelectorAll('.activity-item')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const fg = parse(getComputedStyle(el).color);
    if (!fg) continue;
    out.push({ text: el.getAttribute('aria-label') || 'icon', graphic: true,
               cls: el.className.toString().slice(0,40),
               ratio: Math.round(ratio(fg, bgOf(el))*100)/100 });
  }
  return out;
}"""

def expand_tree(page, passes=6):
    """Open every branch of the script tree.

    The tree ships COLLAPSED from 1.6.0 (Nigel, 02/09/2026) — quick open is the
    fast path now, and a whole project's scripts open on landing is a column that
    has to be scrolled before anything can be chosen. Every suite that clicks a
    script row has to open its branch first, so this is the shared way to do it.

    Repeated, because opening a package reveals the packages nested inside it.
    """
    for _ in range(passes):
        shut = page.locator('.file-tree [aria-expanded="false"]')
        count = shut.count()
        if count == 0:
            return
        for index in range(count):
            try:
                shut.nth(index).click()
            except Exception:
                pass          # a click that re-renders the list is not a failure
        page.wait_for_timeout(120)


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={"width":1600,"height":1000}).new_page()
    login(page)
    page.goto(GATEWAY_URL + SPA, wait_until="load", timeout=30000)
    page.wait_for_selector(".file-tree-header", timeout=20000)
    expand_tree(page)
    page.locator(".file-tree-item").first.click()
    page.wait_for_timeout(2500)
    page.locator('button[aria-label="Toggle panel"]').click()
    page.wait_for_timeout(600)
    ids = page.locator('select[aria-label="Theme"] option').evaluate_all("e=>e.map(x=>x.value)")
    worst_overall = []
    for tid in ids:
        page.select_option('select[aria-label="Theme"]', tid)
        page.wait_for_timeout(450)
        rows = page.evaluate(MEASURE)
        # A graphic clears at 3:1 (WCAG 1.4.11), text at 4.5:1.
        bad = [r for r in rows if r["ratio"] < (3.0 if r.get("graphic") else 4.5)]
        worst = min((r["ratio"] for r in rows), default=99)
        graphics = [r for r in rows if r.get("graphic")]
        # Printed so the pass cannot silently measure nothing. The activity bar
        # has no text, so it was invisible to the text loop for three releases;
        # a count of 0 here means the new pass is measuring air.
        print(f"{tid:26} elements={len(rows):3} (icons {len(graphics):2}, "
              f"worst icon {min((r['ratio'] for r in graphics), default=0):5.2f})  "
              f"worst={worst:5.2f}  below-bar={len(bad)}")
        for r in sorted(bad, key=lambda x: x["ratio"])[:4]:
            print(f"      {r['ratio']:5.2f}  {r['cls'][:34]:34} {r['text']!r}")
        if bad:
            worst_overall.append(tid)
        page.screenshot(path=f"{OUT}/theme-{tid}.png")
    b.close()
print()
print("THEMES WITH ILLEGIBLE TEXT:", worst_overall or "none")
sys.exit(1 if worst_overall else 0)
