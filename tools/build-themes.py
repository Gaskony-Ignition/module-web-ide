#!/usr/bin/env python3
"""
Generate the IDE's theme stylesheet from the estate's Perspective theme packs.

The Web IDE runs in a browser tab next to Perspective sessions wearing the
same ten themes, and two tools on one gateway looking like different products is
a worse outcome than either looking slightly wrong. So the colours are not
chosen here: they are DERIVED from `ignition-themes/packs/*.json`, which is the
source of truth for the estate's look (styles-v2 is retired and those ten packs
are the only surviving copy — see the workspace CLAUDE.md).

Run after `tools/sync-packs.sh` in ignition-themes, or whenever a pack changes:

    python3 tools/build-themes.py [--packs <dir>] [--out <file>]

The output is committed, deliberately. A generated file in the repo means the
module builds without a sibling checkout present, and `--check` in CI proves the
committed copy still matches the packs.
"""
from __future__ import annotations

import argparse
import itertools
import json
import pathlib
import sys

# ---- colour primitives ----------------------------------------------------
#
# sRGB in 0-1 throughout, and WCAG relative luminance for contrast. Everything
# else in this file is built on these four.


def _parse(colour: str):
    """sRGB 0-1 from a hex or rgb()/rgba() string, or None if it is neither."""
    if not colour:
        return None
    c = colour.strip()
    if c.startswith("#"):
        c = c[1:]
        if len(c) == 3:
            c = "".join(ch * 2 for ch in c)
        if len(c) != 6:
            return None
        try:
            return tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))
        except ValueError:
            return None
    if c.startswith("rgba(") or c.startswith("rgb("):
        body = c[c.index("(") + 1:c.rindex(")")]
        parts = [x.strip() for x in body.replace("/", ",").split(",")]
        if len(parts) < 3:
            return None
        try:
            return tuple(float(x) / 255 for x in parts[:3])
        except ValueError:
            return None
    return None


def _luminance(rgb) -> float:
    def channel(v: float) -> float:
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _mix(rgb, towards, amount: float):
    return tuple(c + (t - c) * amount for c, t in zip(rgb, towards))


def _hex(rgb) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in rgb)


def _to_hsl(rgb):
    r, g, b = rgb
    hi, lo = max(rgb), min(rgb)
    lightness = (hi + lo) / 2
    if hi == lo:
        return 0.0, 0.0, lightness
    d = hi - lo
    sat = d / (2 - hi - lo) if lightness > 0.5 else d / (hi + lo)
    if hi == r:
        hue = ((g - b) / d) % 6
    elif hi == g:
        hue = (b - r) / d + 2
    else:
        hue = (r - g) / d + 4
    return hue / 6, sat, lightness


def _from_hsl(hsl):
    hue, sat, lightness = hsl
    if sat == 0:
        return (lightness, lightness, lightness)
    q = lightness * (1 + sat) if lightness < 0.5 else lightness + sat - lightness * sat
    p_ = 2 * lightness - q

    def channel(t):
        t = t % 1.0
        if t < 1 / 6:
            return p_ + (q - p_) * 6 * t
        if t < 1 / 2:
            return q
        if t < 2 / 3:
            return p_ + (q - p_) * (2 / 3 - t) * 6
        return p_

    return (channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3))


def lift_to_contrast(rgb, surfaces, minimum: float, dark: bool):
    """
    Move a colour to legibility **keeping its hue and saturation**.

    Mixing toward white is what the 1.2.0 generator did, and it desaturates: a
    brand teal lifted that way arrives grey-green and stops reading as the
    theme's colour at all. Raising HSL lightness keeps `#0f766e` recognisably
    teal, which is the entire reason a pack names a brand accent.

    The search is for the SMALLEST lightness change that clears the bar, tried
    in the direction that suits the theme's polarity first — a mid-tone brand on
    a mid-tone page can be illegible in both directions for several steps.

    Returns (rgb, wasAdjusted).
    """
    if all(_ratio(rgb, s) >= minimum for s in surfaces):
        return rgb, False
    hue, sat, lightness = _to_hsl(rgb)
    start = int(round(lightness * 100))
    up = list(range(start, 101))
    down = list(range(start, -1, -1))
    for value in (up + down) if dark else (down + up):
        candidate = _from_hsl((hue, sat, value / 100))
        if all(_ratio(candidate, s) >= minimum for s in surfaces):
            return candidate, True
    return ((1.0, 1.0, 1.0) if dark else (0.0, 0.0, 0.0)), True


def accent_bg(hex_colour: str, dark: bool) -> str:
    """A translucent wash of the accent, for selections and active rows."""
    return f"color-mix(in srgb, {hex_colour} {'30' if dark else '20'}%, transparent)"


# ---- geometry -------------------------------------------------------------
#
# Colour was the whole of a theme here until the themes pass, and it is why all
# ten read as one VS Code-shaped shell recoloured while the Perspective sessions
# beside them read as ten products (Nigel, 02/09/2026). The packs carry GEOMETRY as well,
# and it varies far more than the palettes do: `radius.card` runs from 0 on
# `newsprint-night` to 18px on the aurora pair, and four of the ten packs name
# no shadow at all.
#
# Geometry is also the safe half. A radius cannot make text illegible, which is
# why it is taken in full while the surfaces are still derived — see the long
# note above about what mapping a semantic palette onto a lightness ramp did to
# five of these themes in 1.2.0.


def _px(raw: str | None, lo: float, hi: float, fallback: str) -> str:
    """
    A pack length, clamped into a band the IDE's chrome can wear.

    Clamped rather than copied because a Perspective card is a 300px panel and
    an IDE control is a 24px button: `radius.chip: 999px` on a tab makes a
    lozenge, not a tab. The clamp keeps the pack's ORDER (0 stays flattest,
    18px stays roundest) while keeping every value usable at this scale.
    """
    if raw is None:
        return fallback
    text = str(raw).strip().lower()
    if text in ("0", "0px"):
        return "0"
    if not text.endswith("px"):
        return fallback
    try:
        value = float(text[:-2])
    except ValueError:
        return fallback
    value = max(lo, min(hi, value))
    return "0" if value == 0 else f"{value:g}px"


def _shadow_parts(spec: str):
    """(list of lengths, 'rgba(...)' colour) from a CSS shadow, or None."""
    if not spec:
        return None
    text = spec.strip()
    start = text.find("rgba(")
    if start < 0:
        start = text.find("rgb(")
    if start < 0:
        return None
    end = text.find(")", start)
    if end < 0:
        return None
    colour = text[start:end + 1]
    lengths = []
    for token in text[:start].split():
        cleaned = token[:-2] if token.endswith("px") else token
        try:
            lengths.append(float(cleaned))
        except ValueError:
            return None
    if not lengths:
        return None
    return lengths, colour


def _alpha_of(colour: str) -> float:
    body = colour[colour.index("(") + 1:colour.rindex(")")]
    parts = [p.strip() for p in body.replace("/", ",").split(",")]
    if len(parts) < 4:
        return 1.0
    try:
        return float(parts[3])
    except ValueError:
        return 1.0


# The most a popup shadow may spend, per length, in the order CSS reads them:
# x, y, blur, spread. A card shadow scaled for a floating layer runs away —
# aurora's `0 8px 32px` tripled is a 96px blur, which is a fog rather than an
# edge. Capping keeps the pack's proportions where they fit and stops the two
# soft packs turning the palette into a cloud.
SHADOW_CAPS = (12.0, 12.0, 36.0, 8.0)


# The least a popup shadow may spend, in the same order: x, y, blur, spread.
#
# Measured in the browser 03/09/2026: `nord`, `finance-ledger` and
# `leather-parchment-tan` all name `0 1px 2px` at 6-8% alpha, and scaling that
# for a floating layer still gives `0 3px 6px` — which a reviewer sampling the
# pixels across the palette's edge could not find at all. A rounded theme whose
# palette reads as LESS separated than the flat themes' has the story backwards,
# so a shadow that exists must be visible. `none` is unaffected: a pack that
# names no shadow still gets none, and separates with --border-strong.
SHADOW_FLOORS = (0.0, 6.0, 16.0, 0.0)


def elevate(spec: str | None, scale: float, alpha_scale: float, alpha_floor: float,
            alpha_cap: float, caps=None, floors=None) -> str:
    """
    The pack's shadow, restated at a different elevation.

    A pack's `shadow.card` is the elevation of a Perspective CARD sitting on the
    page — `nord` says `0 1px 2px rgba(16,24,40,.06)`, which under a floating
    command palette is no shadow at all. Scaling it keeps the pack's shadow
    LANGUAGE (nord stays a tight neutral drop, aurora stays a wide soft one)
    while giving a layer that floats over code enough to read as floating.

    A pack with no shadow token gets `none`, and that is the intended answer:
    `industrial-*` and `newsprint-night` are flat by design, and they separate
    their layers with a border instead — see --border-strong.
    """
    parts = _shadow_parts(spec or "")
    if parts is None:
        return "none"
    lengths, colour = parts
    rgb = _parse(colour) or (0, 0, 0)
    alpha = min(alpha_cap, max(alpha_floor, _alpha_of(colour) * alpha_scale))
    scaled = []
    for index, value in enumerate(lengths):
        limit = (caps or SHADOW_CAPS)[index] if index < len(caps or SHADOW_CAPS) else None
        out = value * scale
        if limit is not None:
            out = max(-limit, min(limit, out))
        if floors is not None and index < len(floors):
            floor = floors[index]
            out = max(floor, out) if out >= 0 else min(-floor, out)
        scaled.append(out)
    sized = " ".join("0" if round(v, 1) == 0 else f"{round(v, 1):g}px" for v in scaled)
    channels = ", ".join(str(round(c * 255)) for c in rgb)
    return f"{sized} rgba({channels}, {round(alpha, 3):g})"


def brand_glow(spec: str | None, accent: str) -> str:
    """
    The pack's button shadow, recoloured to the theme's own accent.

    Both aurora packs name `0 4px 16px rgba(139,92,246,.45)` — a violet glow,
    including on `aurora-teal`, whose whole identity is that it is the teal one.
    So a CHROMATIC button shadow keeps its geometry and takes the accent this
    generator resolved; a neutral one (a plain black drop) is left alone, since
    that is a shadow rather than a brand mark.
    """
    parts = _shadow_parts(spec or "")
    if parts is None:
        return "none"
    lengths, colour = parts
    rgb = _parse(colour) or (0, 0, 0)
    sized = " ".join("0" if v == 0 else f"{v:g}px" for v in lengths)
    alpha = _alpha_of(colour)
    chromatic = (max(rgb) - min(rgb)) > 0.06
    tint = _parse(accent) if chromatic else rgb
    channels = ", ".join(str(round(c * 255)) for c in (tint or rgb))
    return f"{sized} rgba({channels}, {round(alpha, 3):g})"


def softness(tokens: dict) -> float:
    """
    How soft the pack is, 0 (hard) to 1 (soft), from its own geometry.

    Half the card radius, half whether it casts a shadow at all — the two
    signals every one of these packs carries, and the two a reader sees first.
    `newsprint-night` scores 0 and `aurora-*`/`nord-*` score 1, which is exactly
    the difference Nigel is asking about.

    It is used to scale the neutral ramp: a flat theme has to separate its
    chrome with a STEP, because it has no shadow and no rounding to do it with,
    and a soft one does not — a wide step under a rounded, shadowed panel reads
    as two mismatched greys.
    """
    radius = _px(tokens.get("radius.card"), 0, 16, "6px")
    value = 0.0 if radius == "0" else float(radius[:-2])
    shadow = 1.0 if _shadow_parts(tokens.get("shadow.card") or "") else 0.0
    return 0.5 * (value / 16.0) + 0.5 * shadow


# Row and control heights by the pack's own content spacing. Three bands, not a
# formula: seven of the ten packs agree on `space.content: 24px`, so a
# continuous mapping would invent differences the packs do not carry. The two
# `industrial` packs are genuinely dense (12px and 14px — a control-room
# layout), `newsprint-night` is genuinely roomy (26px), and the rest sit where
# the IDE already was.
#
# Heights, never padding: a <select> and a <button> with the same padding come
# out different heights, which is what "squished" looked like in 1.4.2.
# `space.content` runs 12px (industrial-day) to 26px (newsprint) across the ten
# packs, and THREE bands collapsed six of them onto one row height. Mapped
# continuously instead, so a pack that asked for tighter spacing gets it.
#
# The floor is 20px, not lower: 13px chrome text in a 18px row clips its
# descenders, and a row nobody can read is not a denser row.
DENSITY_MIN, DENSITY_MAX = 12.0, 26.0
ROW_MIN, ROW_MAX = 20.0, 26.0


def density(tokens: dict) -> tuple[str, str]:
    """(row height, control height) for this pack's content spacing."""
    raw = (tokens.get("space.content") or "24px").split()[0]
    try:
        content = float(raw[:-2]) if raw.endswith("px") else 24.0
    except ValueError:
        content = 24.0
    content = max(DENSITY_MIN, min(DENSITY_MAX, content))
    span = (content - DENSITY_MIN) / (DENSITY_MAX - DENSITY_MIN)
    row = round(ROW_MIN + span * (ROW_MAX - ROW_MIN))
    # The control is always two above the row: a button flush with a list row
    # has nowhere to show a focus ring.
    return f"{row:g}px", f"{row + 2:g}px"


def clamp_contrast(rgb, page, low: float, high: float, dark: bool):
    """
    Hold a NON-TEXT colour inside a contrast band against the page.

    For borders and rules, where the failure modes are both directions: too
    close to the page and the line is invisible, too far and a hairline reads
    louder than the text beside it. Lightness moves, hue and saturation do not,
    so `industrial-control-cyan`'s cold steel border stays cold steel.

    This is the ONLY pack surface colour that reaches the IDE, and it is safe
    for the reason the 1.2.0 mapping was not: nothing is ever painted ON a
    border, so no value it can take makes any text illegible.
    """
    hue, sat, lightness = _to_hsl(rgb)
    ratio = _ratio(rgb, page)
    if low <= ratio <= high:
        return rgb
    start = int(round(lightness * 100))
    away = list(range(start, 101)) if dark else list(range(start, -1, -1))
    toward = list(range(start, -1, -1)) if dark else list(range(start, 101))
    order = away if ratio < low else toward
    for value in order:
        candidate = _from_hsl((hue, sat, value / 100))
        if low <= _ratio(candidate, page) <= high:
            return candidate
    return rgb


# Where a pack's line colour is looked for, best first. `border.card` is the
# rule around a panel, which is the closest thing Perspective has to the IDE's
# chrome separators; `border.sidebar` is the next.
BORDER_SOURCES = ("border.card", "border.sidebar", "border.table-cell", "border.primary")


# ---- material -------------------------------------------------------------
#
# Geometry and colour were the whole of a theme here until 1.8.0, and it is why
# `aurora-teal` came out "a plain teal" beside the Perspective session wearing
# the same pack (Nigel, 03/09/2026). The glass in Glass Aurora is not a colour.
# It is a MATERIAL: translucent white films stacked over a lit ground, with a
# 22%-white hairline along each edge where the light catches it.
#
#     surface.sidebar  rgba(255,255,255,0.06)
#     surface.card     rgba(255,255,255,0.10)
#     surface.chip     rgba(255,255,255,0.16)
#     border.card      rgba(255,255,255,0.22)
#
# Compositing those to opaque hex — which is what this file did — turns three
# panes of glass over a lit ground into three flat greys. The alpha is the
# whole effect, so it is carried through as alpha.
#
# The material is READ FROM THE PACK, never switched on the pack's name: a pack
# that paints translucent films is glass, one that paints opaque surfaces is
# not, and a new pack gets the right treatment without this file learning its
# name.

FILM_SOURCES = {
    "--bg-secondary": ("surface.sidebar", "surface.card"),
    "--bg-tertiary": ("surface.chip", "surface.readout", "surface.card"),
    "--surface": ("surface.card", "surface.kpi-tile"),
    "--bg-chrome": ("surface.topbar", "surface.sidebar"),
}


def _rgba(colour: str):
    """(rgb, alpha) from a CSS colour, or None. `_parse` drops the alpha."""
    rgb = _parse(colour)
    if rgb is None:
        return None
    text = str(colour).strip().lower()
    alpha = 1.0
    if text.startswith("rgba("):
        parts = [x.strip() for x in text[5:text.rindex(")")].replace("/", ",").split(",")]
        if len(parts) >= 4:
            try:
                alpha = max(0.0, min(1.0, float(parts[3])))
            except ValueError:
                alpha = 1.0
    return rgb, alpha


def composite(rgb, alpha: float, base):
    """`rgb` at `alpha` painted over `base` — what the eye actually receives."""
    return tuple(rgb[i] * alpha + base[i] * (1 - alpha) for i in range(3))


def film(tokens: dict, names) -> tuple | None:
    """The pack's translucent film for one role, as (rgb, alpha), or None.

    Opaque values return None: a pack that names a solid sidebar is not glass
    and must not be given an alpha it never asked for.
    """
    for name in names:
        raw = tokens.get(name)
        if not raw:
            continue
        parsed = _rgba(raw)
        if parsed is None:
            continue
        rgb, alpha = parsed
        if alpha < 0.98:
            return rgb, alpha
    return None


def is_glass(tokens: dict) -> bool:
    """True where the pack builds its chrome from translucent films.

    Two of the four roles, so one stray rgba in a pack that is otherwise solid
    does not turn an industrial HMI into frosted glass.
    """
    return sum(film(tokens, names) is not None
               for names in FILM_SOURCES.values()) >= 2


def hairline(tokens: dict):
    """The pack's luminous edge, as (rgb, alpha), or None where it draws lines.

    `border_from_pack` REFUSES a translucent border and falls back to the ramp,
    which was right while surfaces were opaque and is wrong now: a 22%-white
    hairline on a translucent pane is most of what reads as glass.
    """
    for name in ("border.card", "border.sidebar", "border.topbar"):
        parsed = _rgba(tokens.get(name) or "")
        if parsed and parsed[1] < 0.98:
            return parsed
    return None


def css_rgba(rgb, alpha: float) -> str:
    """`rgba(r, g, b, a)` at 8-bit precision, for emission."""
    r, g, b = (int(round(max(0.0, min(1.0, c)) * 255)) for c in rgb)
    return f"rgba({r}, {g}, {b}, {alpha:g})"


# How much of its own colour a floating panel keeps.
#
# 0.94 was too dense to be glass: `backdrop-filter` had nothing left to show and
# the review came back "an opaque panel, not glass". At 0.78 the code moves
# under the palette as a blurred wash, which is the whole effect.
#
# The bound is the app's OWN ground, not pure white and black. A palette here
# can only float over the editor, and the editor IS the ground — page at its
# darkest, page-plus-glow at its brightest. Bounding against white was both
# wrong and unreachable: nothing is legible on a panel 22% white in a dark
# theme, so the search silently failed and left the token unchanged.
GLASS_PANEL_ALPHA = 0.78


# The brightest a glow may add over the ground. Every text token is verified
# against the ground WITH this much accent mixed in, because a gradient is
# invisible to the browser sweep: `getComputedStyle` reports `background-color`
# and a gradient is a background-IMAGE, so the live gate cannot see it. It has
# to be bounded here or it is not bounded anywhere.
# Pushed hard, deliberately. At 0.20 the ground read as "a flat violet with a
# faint tint in one corner" (Nigel, 03/09/2026: "still quite a bit of the
# styling feels a bit dull"). The glow is what carries a glass theme's identity:
# the aurora pair share one authored ground by design, so if the ground is the
# only colour on screen they are the same theme twice. At 0.42 the teal pack
# reads GREEN-glass and the violet pack reads violet, over the same #1a1233.
#
# It cannot cost legibility however high it goes: the brightest point of the
# glow is composited below and every text token is verified against it.
GLOW_ALPHA = 0.42
GLOW_SECOND_ALPHA = 0.34
GLOW_THIRD_ALPHA = 0.22

# The non-glass wash. Below this softness a pack is HARD — flat, square,
# shadowless — and gets no ground light at all, because that is its identity.
WASH_MIN_SOFTNESS = 0.25
WASH_BASE = 0.16
WASH_SCALE = 0.22
# The centred stop, relative to the corner one. Lower, because it sits directly
# under the code and its job is to lift the ground, not to colour the text.
WASH_CENTRE_FACTOR = 0.62
# A light theme takes less: the same alpha that reads as a soft glow on a dark
# ground reads as a stain on a pale one.
LIGHT_WASH_FACTOR = 0.55


def page_glow(tokens: dict, page, glass: bool, dark: bool, accent: str) -> str:
    """
    The lit ground a glass pack's panes are there to reveal.

    Films alone do not make glass. Measured on the rig at 1.8.0: with a FLAT
    ground, `rgba(255,255,255,0.06)` over a dark violet is a shade of the same
    violet, so the rail, the header and the canvas all read as one flat block
    and the review came back "the panel IS the ground" — a recolour, not a
    material. Perspective's Glass Aurora is not flat: an aurora is a gradient,
    and the panes catch different parts of it. That is where the depth is.

    Two wide radial glows, in the pack's own accent, painted UNDER everything.
    They cannot make text illegible: the brightest point is bounded by
    GLOW_ALPHA and that composite is one of the surfaces every text token is
    checked against.
    """
    # Not glass, but not nothing.
    #
    # Nigel, 03/09/2026: this is about the whole suite, not the two glass packs.
    # A wash scaled by how SOFT the pack is, because that is the axis the packs
    # already differ on: `nord-*` and `leather-parchment` are rounded, shadowed
    # and soft, and a gentle light in one corner is exactly their character.
    #
    # The hard packs get NONE, deliberately. `newsprint-night` is ink on paper
    # and `industrial-*` is a control-room HMI; flatness is what they ARE, and
    # lighting them would be the same mistake as flattening the aurora pair.
    if not glass:
        soft = softness(tokens)
        if soft < WASH_MIN_SOFTNESS:
            return "none"
        alpha = (WASH_BASE + WASH_SCALE * soft) * (1.0 if dark else LIGHT_WASH_FACTOR)
        tint = _parse(accent) or (1.0, 1.0, 1.0)
        # TWO stops, and the second one INSIDE the window.
        #
        # A single stop centred off-canvas at 4%/-10% is already deep in its own
        # falloff by mid-screen: measured on the rig, ~8% of the nominal alpha
        # survived to the centre and the wash moved the ground by 2 of 255 — a
        # gradient that is only in the file. The corner stop gives the direction
        # and the centred one gives it something to actually light.
        return (f"radial-gradient(1400px 1000px at 2% -12%, "
                f"{css_rgba(tint, round(alpha, 3))}, transparent 70%), "
                f"radial-gradient(1100px 820px at 72% 58%, "
                f"{css_rgba(tint, round(alpha * WASH_CENTRE_FACTOR, 3))}, transparent 72%)")
    second = None
    for name in ("accent.info", "accent.secondary", "surface.nav-active", "accent.ok"):
        parsed = _rgba(tokens.get(name) or "")
        if parsed:
            second = parsed[0]
            break
    first = _parse(accent) or (1.0, 1.0, 1.0)
    if second is None:
        second = first
    # Three stops, sized past the window on purpose: a gradient that ends inside
    # the viewport draws a visible edge, and an aurora has none. The middle one
    # lights the centre, which is where the code is.
    return (f"radial-gradient(1400px 980px at 6% -14%, "
            f"{css_rgba(first, GLOW_ALPHA)}, transparent 64%), "
            f"radial-gradient(1200px 900px at 98% 112%, "
            f"{css_rgba(second, GLOW_SECOND_ALPHA)}, transparent 62%), "
            f"radial-gradient(1100px 780px at 62% 42%, "
            f"{css_rgba(first, GLOW_THIRD_ALPHA)}, transparent 70%)")


def lit_edge(shadow: str, edge) -> str:
    """
    A drop shadow with the pane's lit top edge added, where the pack has one.

    Folded into the shadow rather than emitted as its own token because
    `box-shadow: none, inset ...` is not valid CSS, and four of the ten packs
    cast no shadow — so a second token would have to be composed with `none` at
    every call site. A pack with no luminous edge gets its shadow back
    untouched, `none` included.
    """
    if not edge:
        return shadow
    highlight = f"inset 0 1px 0 {css_rgba(edge[0], min(1.0, edge[1] * 2.2))}"
    return highlight if shadow == "none" else f"{shadow}, {highlight}"


def glass_panel(surface, glass: bool) -> str:
    """
    The background for a layer that floats OVER CODE — the palette, the dialogs.

    `--surface` cannot do this job on a glass pack. It is the pack's own film,
    `rgba(255,255,255,0.10)`, which is right over a page and useless over an
    editor: at 10% the code shows through and competes with the palette's own
    rows. The floating layer instead gets that film ALREADY COMPOSITED over the
    page, re-emitted at 94% — dense enough to hide what is behind it, sheer
    enough that the ground still moves under it. With `--blur-panel` over the
    top it reads as frosted glass rather than as a transparency bug.
    """
    return css_rgba(surface, GLASS_PANEL_ALPHA) if glass else _hex(surface)


def _lerp(at_hard: float, at_soft: float, soft: float) -> float:
    """Interpolate a value between its hard-pack and soft-pack ends."""
    return at_hard + (at_soft - at_hard) * max(0.0, min(1.0, soft))


def border_from_pack(tokens: dict, page, dark: bool, low: float = 1.5,
                     high: float = 4.0):
    """
    The pack's own line colour, banded — or None to fall back to the ramp.

    Translucent values are refused outright rather than flattened: the aurora
    packs draw their borders as `rgba(255,255,255,0.22)`, which is not a colour
    until it has been composited, and dropping the alpha yields WHITE.
    """
    for name in BORDER_SOURCES:
        raw = tokens.get(name)
        if not raw or raw == "transparent" or str(raw).strip().startswith("rgba"):
            continue
        rgb = _parse(raw)
        if rgb is None:
            continue
        return clamp_contrast(rgb, page, low, high, dark)
    return None


# ---------------------------------------------------------------------------
# Why the IDE's neutrals are DERIVED, not mapped.
#
# The first version of this file mapped Perspective's surfaces straight onto the
# IDE's scale: surface.page -> --bg-primary, surface.sidebar -> --bg-secondary,
# surface.card -> --surface. It rendered five of the ten themes ILLEGIBLE, and
# the generator's own contrast check passed throughout, because it measured
# tokens against --bg-primary while the app paints most of its text on
# --bg-secondary.
#
# The mistake was treating a SEMANTIC palette as a lightness ramp. Perspective's
# "sidebar" is branded chrome, not "slightly off the page": in finance-ledger it
# is dark navy in a light theme, so dark body text landed on it at 2.07:1. The
# glass themes are worse — their surfaces are `rgba(255,255,255,0.06)`, which is
# not a colour at all and cannot be reasoned about without compositing.
#
# So: the neutral ramp is COMPUTED from the page colour, the way VS Code's own
# themes are built (editor, then sidebar a step off it, then borders). The pack
# supplies what a palette is actually for — the accent and the syntax hues — and
# every one of those is checked against every surface it can land on.
# ---------------------------------------------------------------------------

# Accent roles, and the pack tokens that might carry them, best first. The
# resolver picks the first that is LEGIBLE, not the first that exists — see
# pick_legible.
ACCENT_SOURCES: dict[str, tuple[str, ...]] = {
    "--accent-primary": ("accent.primary", "text.status-info", "accent.alarm-low"),
    # `border.danger` sits ahead of `accent.alarm-high` because the two
    # industrial packs paint "alarm-high" AMBER — high PRIORITY, not danger —
    # and taking it would have made --error and --warning one colour. Where a
    # pack sets both, `text.status-alarm` is still first and this never fires.
    "--error": ("text.status-alarm", "border.danger", "accent.alarm-high",
                "accent.delta-down", "accent.danger"),
    "--warning": ("text.status-warn", "text.readout-value-warn", "accent.alarm-med"),
    "--success": ("text.status-ok", "accent.delta-up", "surface.pill-dot"),
    "--syntax-keyword": ("accent.primary", "text.status-info", "accent.alarm-low"),
    "--syntax-string": ("text.status-ok", "accent.delta-up", "surface.pill-dot"),
    "--syntax-number": ("text.status-warn", "text.readout-value-warn", "accent.alarm-med"),
    "--syntax-type": ("accent.progress", "text.status-info", "accent.primary"),
    "--syntax-function": ("text.status-info", "accent.alarm-low", "accent.primary"),
    "--syntax-comment": ("text.muted",),
}

# How far each neutral sits from the page, as a fraction toward white (dark
# themes) or black (light themes). Modelled on VS Code's own steps: the side bar
# is a small lift off the editor, the panel/active row a little more, and the
# border is the first step that must be visible on its own.
DARK_RAMP = {"secondary": 0.05, "tertiary": 0.11, "surface": 0.07, "border": 0.18}
LIGHT_RAMP = {"secondary": 0.045, "tertiary": 0.10, "surface": 0.02, "border": 0.20}

# Text is placed by TARGET CONTRAST rather than by hue, so "muted" means the same
# thing in every theme instead of meaning whatever the pack happened to hold.
#
# 13:1 was the 1.2.0 setting and it renders body text very close to white, which
# is brighter than any editor ships and is tiring over a working day. VS Code's
# own default is #cccccc on #1f1f1f: 10.4:1. These targets put every theme in
# that neighbourhood, still comfortably past WCAG AAA's 7:1 for body text.
TEXT_TARGETS = {"primary": 10.5, "secondary": 6.2, "muted": 4.6}

# Every surface a foreground can land on. A colour must clear the bar on ALL of
# them, because the same token paints the tree (secondary), the editor (primary),
# a hovered row (tertiary) and the activity bar (chrome).
SURFACE_KEYS = ("--bg-primary", "--bg-secondary", "--bg-tertiary", "--bg-chrome")

MIN_ACCENT_CONTRAST = 4.5
MIN_TEXT_CONTRAST = 4.5

# ---- a signal colour has to BE a colour ------------------------------------
#
# The roles below exist to be told apart by HUE at a glance: an error, a
# warning, a success. A grey one is not a dimmer version of the right answer,
# it is the wrong answer — and until 1.11.0 three of the ten packs shipped one.
#
# The cause is the 1.2.0 lesson again, one level down. `text.status-alarm` is
# not the pack's alarm colour: it is the INK that goes ON an alarm chip, and in
# a light industrial pack that ink is #FFFFFF. `pick_legible` takes the first
# token PRESENT — correctly, so a brand teal is never swapped for an info blue
# — so a present-but-achromatic ink token beat the real signal colour every
# time. Measured 04/09/2026 across the ten packs:
#
#     industrial-day-cyan     alarm #FFFFFF   ok #6B7280   -> #545454 / #4f545e
#     leather-night-tan       alarm #1b120a   ok #1b120a   -> ONE colour, twice
#     leather-parchment-tan   alarm #fdf6e8   ok #fdf6e8   -> ONE colour, twice
#
# Two themes painted their error and their success identically. That is not the
# cosmetic near-miss it was recorded as at 1.7.0; it is a signal that cannot
# signal, and no amount of contrast lifting fixes it because lightness is the
# only axis lifting moves.
#
# So a signal role SKIPS a candidate that carries no colour, and falls through
# to the next — which in all three packs is the colour a reader would have
# named if asked. Every other role, `--syntax-comment` above all, is exempt: a
# comment is SUPPOSED to be grey, and `text.muted` is the right token for it.
#
# The floor is 28/255, read off the measured spread of every signal candidate
# in all ten packs, not chosen. Sorted, the 110 candidates run:
#
#     0, 0, 0, 17, 17, 17, 21, 21, 21, 21, 26, 26 | 31, 31, 31, 32, 47, 49, ...
#
# and the bar goes in the one gap there is. Everything below it is a white, a
# near-black or a Tailwind slate — ink for a chip, every one. Everything above
# it is a red, an amber or a green. Nothing lands within 2/255 of the bar in
# either direction, and no theme that was already right moves: `nord-light-frost`
# keeps #657657 at 31 and `nord-dark-frost` keeps #c5d6b6 at 32.
#
# It is a narrow gap, and that is the finding rather than a weakness of the
# method: a pack either states a signal colour or states the ink that goes on
# one, and the two do not overlap.
SIGNAL_ROLES = frozenset({"--error", "--warning", "--success"})
SIGNAL_CHROMA_MIN = 28 / 255

# The bar the SHIPPED colour is held to, and it is a different measure on
# purpose. Chroma is the right test on a pack's stated token, where a white ink
# scores 0 and a red scores 182. It is the wrong test afterwards, because
# `lift_to_contrast` moves LIGHTNESS to reach 4.5:1 and chroma is capped by
# lightness — `nord-light-frost`'s green #657657 is a legitimate 31 before the
# lift and 25 after it, having lost nothing but brightness.
#
# HSL saturation is lightness-invariant, so it survives the lift and still reads
# zero on a grey. The shipped spread across the ten themes is 0.15 (that same
# Nord green) to 1.00; 0.12 clears the lowest with margin and still refuses
# 1.11.0's own output, where `industrial-day-cyan` shipped 0.00 and 0.09.
SIGNAL_SATURATION_MIN = 0.12

# How much of the theme's brand accent is stirred into the neutral ground.
#
# Not decoration. `aurora-teal` and `aurora-violet` are byte-identical packs
# apart from `accent.primary` and `accent.progress` — in Perspective they read
# differently because the glass surfaces tint with the accent, and with a purely
# page-derived ramp the IDE rendered the teal theme in violet. A ground that
# carries a trace of the brand is how VS Code themes differ from one another
# too, and it is what makes two siblings tell apart at a glance.
#
# The mix changes HUE ONLY: the page's own lightness is restored afterwards.
# Without that, a pack whose brand accent is nearly white — `newsprint-night`
# resolves to #e8e2d6 — has its editor ground dragged three shades lighter than
# the pack asked for, which is a bigger change than the one being made.
ACCENT_TINT = 0.30


# ---- the ground's own colour ----------------------------------------------
#
# Nigel, 03/09/2026: *"still quite a bit of the styling feels a bit dull… the
# different themes really feel beautiful and provide that bit of variety."*
#
# Measured 04/09/2026, and the numbers say it plainly. The four LIGHT packs
# painted grounds whose chroma — the spread between the strongest and weakest
# channel — was 3, 5, 5 and 8 out of 255. Three of their six pairings were
# within 8 RGB of each other on both the page and the rail. They were four
# shades of pale grey, and no amount of material on top of that separates them.
#
# The cause is arithmetic, not taste. A pack states its ground in HSL terms
# (`leather-parchment-tan` is hue 36 at 33% saturation) but at 97% LIGHTNESS the
# most chroma any colour can carry is (1 - |2L - 1|) = 0.06, or 15/255 — and at
# 33% saturation it carries 5. The hue is in the pack, correctly, and is
# invisible on screen. Solarized Light, for comparison, runs 86% saturation at
# the same lightness to reach a chroma of 26.
#
# So the floor is on CHROMA, not on saturation: raise saturation as far as it
# goes at the pack's own lightness, and give up lightness only when saturation
# alone cannot reach the floor. The pack's polarity and its hue both survive.
GROUND_CHROMA_LIGHT = 18 / 255
GROUND_CHROMA_DARK = 20 / 255

# The floor is a floor, not a target: a pack that asks for MORE colour than the
# reference keeps the difference, scaled. `nord-light-frost` states 27%
# saturation and `industrial-day-cyan` 17%, and flattening both to one chroma
# made two packs that are genuinely different amounts of blue land 1 RGB apart.
# Capped, because the point is a ground, not a wash.
CHROMA_REFERENCE_SAT = 0.20
CHROMA_MAX_SCALE = 1.5

# Below this, a page's hue is noise rather than intent — `finance-ledger` reads
# as hue 160 at 10% saturation while every branded thing in the pack (its
# accent, its rail, its card header) is hue 203. Under the floor the ACCENT's
# hue is the honest answer to "what colour is this theme".
PAGE_HUE_MIN_SAT = 0.15


def chroma(rgb) -> float:
    """Distance from the grey axis: what the eye reads as "this has a colour"."""
    return max(rgb) - min(rgb)


def identity_hue(tokens: dict, page, dark: bool) -> float:
    """The hue the pack is ABOUT — its own ground's, or its accent's."""
    hue, sat, _ = _to_hsl(page)
    if sat >= PAGE_HUE_MIN_SAT:
        return hue
    for name in ACCENT_SOURCES["--accent-primary"]:
        rgb = _parse(tokens.get(name) or "")
        if rgb is None:
            continue
        accent_hue, accent_sat, _ = _to_hsl(rgb)
        if accent_sat >= PAGE_HUE_MIN_SAT:
            return accent_hue
    return hue


def chroma_target(page, floor: float) -> float:
    """How much colour this pack's ground should carry.

    Scaled by the saturation the pack ASKED for, so the relative order of the
    ten survives. A page whose saturation is below the noise threshold has not
    asked for anything, and takes the floor.
    """
    _, sat, _ = _to_hsl(page)
    if sat < PAGE_HUE_MIN_SAT:
        return floor
    scale = min(CHROMA_MAX_SCALE, max(1.0, sat / CHROMA_REFERENCE_SAT))
    return floor * scale


def saturate_ground(page, hue: float, floor: float):
    """
    Give the ground enough of its own hue to be seen.

    Lightness is preserved wherever saturation can do the work alone, because
    the page's lightness IS the theme's polarity and the thing every text
    target is computed against. Where it cannot — a 97%-light parchment can
    hold a chroma of 15 at most — lightness gives way half a percent at a time,
    which is below the threshold of noticing and is the only remaining move.
    """
    _, start_sat, lightness = _to_hsl(page)
    toward_mid = 1 if lightness <= 0.5 else -1
    for drop in range(0, 13):
        light = lightness + toward_mid * drop * 0.005
        for sat in range(int(start_sat * 100), 101):
            candidate = _from_hsl((hue, sat / 100, light))
            if chroma(candidate) >= floor:
                return candidate
    return page


# ---- a branded rail -------------------------------------------------------
#
# Two of these packs put a DARK rail on a light page — `finance-ledger`'s
# `#0b3d5c` navy and `leather-parchment-tan`'s `#2f2016` brown — and that
# inversion is the loudest thing about either design. The generator flattened
# both onto its neutral ramp and rendered them as two more pale greys.
#
# This is the ONE place a `surface.*` token is allowed onto a neutral, and it is
# safe for a reason that does not generalise: `--bg-chrome` paints exactly one
# component, the activity bar, whose only foregrounds are its icons — so the
# rail carries its OWN ink tokens rather than the shared ones. Widening this to
# `--bg-secondary` would be the 1.2.0 defect again, because the tree, the tabs
# and the panels all read `--text-primary` on it.
RAIL_SOURCES = ("surface.sidebar", "surface.topbar", "surface.nav")

# How far a rail must sit from the page before it counts as branded rather than
# as one more step off the ramp. Every pack that merely steps its sidebar is
# inside 6%; the two that invert it are at 74% and 83%. Nothing is near 34%.
RAIL_INVERT_DELTA = 0.34


def branded_rail(tokens: dict, page):
    """
    The pack's own rail colour, when it deliberately contradicts the page.

    Returns None for a translucent rail (the aurora pair, whose chrome is a
    film over the ground) and for a rail that is merely a step off the page —
    those are the ramp's job and it does them better, because the ramp scales
    with how flat the pack is.
    """
    _, _, page_light = _to_hsl(page)
    for name in RAIL_SOURCES:
        raw = (tokens.get(name) or "").strip()
        if not raw or raw.startswith("rgba"):
            continue
        rail = _parse(raw)
        if rail is None:
            continue
        _, _, rail_light = _to_hsl(rail)
        if abs(rail_light - page_light) >= RAIL_INVERT_DELTA:
            return rail
    return None


def opaque_page(tokens: dict, dark: bool) -> tuple[float, float, float]:
    """
    The page colour, guaranteed opaque.

    A translucent or missing value is not usable as a ramp base — the glass
    themes' surfaces are `rgba(255,255,255,0.06)` — so it falls back to a neutral
    of the right polarity rather than propagating an unusable value.
    """
    raw = tokens.get("surface.page")
    parsed = _parse(raw) if raw else None
    if parsed is None or (raw and raw.strip().startswith("rgba")):
        parsed = _parse(raw) if raw and not raw.strip().startswith("rgba") else None
    if parsed is None:
        return (0.12, 0.12, 0.14) if dark else (0.98, 0.98, 0.98)
    return parsed


def step(base: tuple[float, float, float], amount: float, dark: bool):
    """Move a colour off the page: lighter in a dark theme, darker in a light one."""
    target = (1.0, 1.0, 1.0) if dark else (0.0, 0.0, 0.0)
    return _mix(base, target, amount)


def text_at(page: tuple[float, float, float], target: float, dark: bool) -> str:
    """
    The text colour that hits `target` contrast against the page.

    Computed rather than taken from the pack: it is the only way "muted" means
    the same thing in all ten themes, and the packs disagree wildly about which
    token is meant to be read against a page at all.
    """
    ink = (1.0, 1.0, 1.0) if dark else (0.0, 0.0, 0.0)
    best, best_gap = ink, 1e9
    for i in range(0, 101):
        candidate = _mix(page, ink, i / 100)
        ratio = _ratio(candidate, page)
        gap = abs(ratio - target)
        if gap < best_gap:
            best, best_gap = candidate, gap
    return _hex(best)


def _ratio(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    la, lb = _luminance(a), _luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def pick_legible(tokens: dict, names: tuple[str, ...], surfaces: list, dark: bool,
                 minimum: float, chroma_floor: float = 0.0) -> tuple[str, bool]:
    """
    The first token the pack actually defines, lifted until it is legible.

    1.2.0 walked the candidate list and took the first that PASSED, which is how
    "Glass Aurora — Teal" came out violet: its brand `#0f766e` failed on the
    page, so the resolver fell through to `text.status-info`, a token the teal
    and violet packs share verbatim. The two themes then differed in one token
    out of eighteen and were indistinguishable on screen.

    A pack's brand colour is not interchangeable with its info colour. So the
    list is now a fallback for a token that is ABSENT, not for one that is dark:
    the first token present is kept and lifted in place, hue intact.
    """
    for name in names:
        raw = tokens.get(name)
        if not raw or raw == "transparent":
            continue
        rgb = _parse(raw)
        if rgb is None:
            continue
        # A signal role skips a colourless candidate — see SIGNAL_CHROMA_MIN.
        # Lifting cannot rescue one: it moves lightness only, so a white
        # alarm ink comes back a grey alarm ink.
        if chroma(rgb) < chroma_floor:
            continue
        lifted, adjusted = lift_to_contrast(rgb, surfaces, minimum, dark)
        return _hex(lifted), adjusted
    return _hex((0.5, 0.5, 0.5)), True


# Syntax roles in the order they keep their colour when two of them collide.
# Comment is first because a comment that stops looking muted reads as code;
# string and number next because they are the two a reader scans for. Type is
# last, and is the one that moves — in these packs it comes from
# `accent.progress`, which several of them set to a near-neighbour of the brand.
SYNTAX_PRIORITY = (
    "--syntax-comment", "--syntax-string", "--syntax-number",
    "--syntax-keyword", "--syntax-function", "--syntax-type",
)

# Below this score two syntax colours are one colour with two names.
#
# **Straight RGB distance was the wrong measure and it let real collisions
# through.** It was 0.07 in a 0–1 cube, which on a LIGHT theme — where every
# syntax colour has to be dark to be legible, and dark colours are crowded near
# the origin — passed almost everything. Measured 04/09/2026:
# `industrial-day-cyan` shipped keyword and type at the same lightness, the same
# saturation and 8° apart, and `finance-ledger` did the same with string and
# type. The guard was green throughout.
#
# A reader tells two colours apart by HUE, or failing that by WEIGHT, or failing
# that by how colourful they are. The score adds all three, and weights the hue
# term by the LOWER of the two saturations — the hue of a grey is noise, so a
# grey comment beside a blue keyword must earn its separation from the
# saturation term instead, which it does easily.
#
# 28 is chosen from the measured spread, not from taste: the ten themes scored
# 7.8, 9.4, 9.9, 17.1, 29.1, 29.4, 29.9, 32.2, 57.5, 66.0. It fires on the four
# genuine collisions and leaves the six that a reader can already tell apart —
# because the separation is a hue rotation, and repainting Nord's function names
# to gain a difference nobody needed is worse than the near-miss it fixed.
SYNTAX_SEPARATION = 28.0


def _separation(a, b) -> float:
    """How distinguishable two syntax colours are. See SYNTAX_SEPARATION."""
    hue_a, sat_a, light_a = _to_hsl(a)
    hue_b, sat_b, light_b = _to_hsl(b)
    turn = abs(hue_a - hue_b)
    hue_gap = min(turn, 1.0 - turn) * 360 * min(sat_a, sat_b)
    return hue_gap + abs(light_a - light_b) * 300 + abs(sat_a - sat_b) * 120


def weigh_apart(rgb, kept, surfaces: list, dark: bool):
    """
    Separate a colour from the ones already placed by MOVING ITS WEIGHT.

    Hue intact, which is why this is the whole of the treatment for a status
    colour and only the fallback for a syntax one: a darker amber is still an
    amber, but an amber rotated 50 degrees to clear a red is a green, and a
    warning that is green is worse than a warning that is nearly a red.

    Tried in the direction that cannot cost contrast first — darker on a light
    theme, lighter on a dark one. Returns None when nothing separates.
    """
    hue, sat, lightness = _to_hsl(rgb)
    toward = 1 if dark else -1
    for shift in (0.06, 0.10, 0.15, 0.21):
        for direction in (toward, -toward):
            moved = min(0.97, max(0.03, lightness + direction * shift))
            trial = _from_hsl((hue, sat, moved))
            trial, _ = lift_to_contrast(trial, surfaces, MIN_ACCENT_CONTRAST, dark)
            if all(_separation(trial, other) >= SYNTAX_SEPARATION
                   for _, other in kept):
                return trial
    return None


# The status colours, in the order they keep their own hue when two collide.
#
# Error first and it never moves: red is the one colour in an IDE whose meaning
# is not negotiable. Success next. Warning is the one that gives way, and it is
# the only one that can afford to — amber has yellow on one side and orange on
# the other, and a reader calls all three "warning".
SIGNAL_PRIORITY = ("--error", "--success", "--warning")


def differentiate_signals(out: dict, surfaces: list, dark: bool, pack_id: str,
                          report: list[str]) -> None:
    """
    Pull apart status colours that resolved to one another.

    `nord-light-frost` is why this exists: Nord's red and its orange, both
    darkened for a light page, arrived as #8a464c and #7b4f42 — a maroon and a
    brown, 22 degrees and 4% of lightness apart, scoring 19.9 against a bar of
    28. Neither is grey and neither is illegible, so nothing before this caught
    them; they are simply the same colour to anyone not holding a swatch.

    Weight only — see weigh_apart for why a status colour is never rotated.
    """
    kept: list[tuple[str, tuple[float, float, float]]] = []
    for role in SIGNAL_PRIORITY:
        rgb = _parse(out[role])
        if rgb is None:
            continue
        clash = next((name for name, other in kept
                      if _separation(rgb, other) < SYNTAX_SEPARATION), None)
        if clash is None:
            kept.append((role, rgb))
            continue
        trial = weigh_apart(rgb, kept, surfaces, dark)
        if trial is None:
            kept.append((role, rgb))
            report.append(f"  {pack_id}: {role} STAYS on {clash} — no weight "
                          f"separates them without rotating its hue")
            continue
        out[role] = _hex(trial)
        kept.append((role, trial))
        report.append(f"  {pack_id}: {role} weighted off {clash} to {out[role]}")


def differentiate_syntax(out: dict, surfaces: list, dark: bool, pack_id: str,
                         report: list[str]) -> None:
    """
    Pull apart syntax colours that resolved to the same hue.

    Ten packs carry about six distinct hues between them, so two syntax roles
    landing on one colour is common rather than exotic — `aurora-teal` gave
    keyword `#18baad` and type `#15bdaa`, which is one colour with two names.
    Highlighting that does not distinguish is worse than no highlighting,
    because it looks deliberate.

    The later role in SYNTAX_PRIORITY is rotated in hue until it separates,
    then re-lifted so the rotation cannot cost legibility.
    """
    kept: list[tuple[str, tuple[float, float, float]]] = []
    for role in SYNTAX_PRIORITY:
        rgb = _parse(out[role])
        if rgb is None:
            continue
        clash = next((name for name, other in kept
                      if _separation(rgb, other) < SYNTAX_SEPARATION), None)
        if clash is None:
            kept.append((role, rgb))
            continue
        hue, sat, lightness = _to_hsl(rgb)
        # Both directions, nearest first: marching one way only walks a warm
        # palette's third collision all the way round to a colour the pack
        # never contained. A saturation floor comes with the rotation, because
        # a hue turn on a near-grey moves nothing a reader can see.
        # Nearest first, and both ways. Marching one direction only walks a warm
        # palette's third collision the long way round to a colour the pack
        # never contained; trying -18° before +50° keeps a rotated role as close
        # to its own family as the separation allows. The arc reaches ±100°
        # because a pack whose six roles all sit inside 60° — `leather-*` and
        # `newsprint-night` do — has nowhere nearer to go, and a number that
        # cannot be told from a string is the worse outcome.
        turns = [d * step for step in (0.05, 0.09, 0.14, 0.20, 0.28) for d in (1, -1)]
        for turn in turns:
            trial = _from_hsl(((hue + turn) % 1.0, max(sat, 0.30), lightness))
            trial, _ = lift_to_contrast(trial, surfaces, MIN_ACCENT_CONTRAST, dark)
            if all(_separation(trial, other) >= SYNTAX_SEPARATION for _, other in kept):
                out[role] = _hex(trial)
                kept.append((role, trial))
                report.append(f"  {pack_id}: {role} rotated off {clash} to {out[role]}")
                break
        else:
            # No hue clears. `nord-light-frost` is the case: six roles inside
            # 40° on a light page, so every turn that separates one pair
            # collides with another. LIGHTNESS always has room, and it is what a
            # reader falls back on when two hues are close — a darker blue and a
            # lighter blue are two colours, where two blues at one weight are
            # one. Tried in the direction that cannot cost contrast first:
            # darker on a light theme, lighter on a dark one.
            trial = weigh_apart(rgb, kept, surfaces, dark)
            if trial is not None:
                out[role] = _hex(trial)
                kept.append((role, trial))
                report.append(f"  {pack_id}: {role} weighted off {clash} "
                              f"to {out[role]}")
            else:
                kept.append((role, rgb))
                report.append(f"  {pack_id}: {role} STAYS on {clash} — no hue or "
                              f"weight separates them")


def block(pack: dict, report: list[str]) -> str:
    tokens = pack["tokens"]
    dark = pack["dark"]
    ramp = DARK_RAMP if dark else LIGHT_RAMP

    # The page the pack was AUTHORED with, un-rotated.
    #
    # This used to be mixed 30% toward the brand accent so siblings told apart.
    # It cost the estate its two best-looking themes: `aurora-teal` and
    # `aurora-violet` share one violet ground (#1a1233) and differ by which
    # colour glows on it — that shared ground IS Glass Aurora. The tint swung
    # aurora-teal's ground to hue 203, actual teal, and Nigel's word for the
    # result was "plain" (03/09/2026). The pack already distinguishes siblings
    # by accent; rotating the ground only destroys the family.
    page = opaque_page(tokens, dark)
    # …but given enough of its own hue to be SEEN. See saturate_ground: a pack
    # can state a hue perfectly and still paint a grey, because chroma is capped
    # by lightness and every light pack here sat near the cap.
    floor = GROUND_CHROMA_DARK if dark else GROUND_CHROMA_LIGHT
    # Only a ground that is BELOW the floor is touched. A pack already carrying
    # its hue — the aurora pair at 33/255 — keeps the exact colour it was
    # authored with, which is the whole of the 1.7.x lesson: the ground IS the
    # family, and moving it is how the two best-looking themes were lost.
    if chroma(page) < floor:
        page = saturate_ground(
            page, identity_hue(tokens, page, dark), chroma_target(page, floor)
        )
    glass = is_glass(tokens)

    # The ramp is SCALED by how soft the pack is. A flat, shadowless, square
    # theme has nothing but the step to separate its chrome from the code, so it
    # gets a wide one; a rounded theme with a shadow already reads as layered and
    # a wide step there just looks like two greys that failed to match.
    soft = softness(tokens)
    ramp_scale = 1.55 - 0.6 * soft
    secondary = step(page, ramp["secondary"] * ramp_scale, dark)
    tertiary = step(page, ramp["tertiary"] * ramp_scale, dark)
    surface = step(page, ramp["surface"] * ramp_scale, dark)
    border = step(page, ramp["border"], dark)
    # The activity bar is the deepest piece of chrome. On a flat theme it sits
    # well off the rail, the way a control-room HMI separates its furniture; on
    # a soft one it is flush with the rail and the border does the work.
    chrome = step(page, ramp["secondary"] * ramp_scale * (1 + 1.2 * (1 - soft)), dark)

    # A glass pack's chrome is emitted as the pack's own films, and composited
    # here only to know what the text will land on. The films are stacked in the
    # order the app stacks them — the hover sits on the rail, not on the page —
    # so the contrast guarantee is made against the colour the eye receives, not
    # against an idealised one-layer version of it.
    # A pack that deliberately inverts its rail keeps it. Only `--bg-chrome` —
    # the activity bar — and only with its own ink; see branded_rail.
    rail = branded_rail(tokens, page)
    if rail is not None:
        chrome = rail
    # Which way the rail's own ink runs. Not the theme's polarity: a branded
    # rail is by definition the opposite of the page, and that is the point.
    rail_dark = _luminance(chrome) < 0.18

    paint = {"--bg-secondary": _hex(secondary), "--bg-tertiary": _hex(tertiary),
             "--surface": _hex(surface), "--bg-chrome": _hex(chrome)}
    if glass:
        over_page = {"--bg-secondary", "--bg-chrome"}
        films = {role: film(tokens, names) for role, names in FILM_SOURCES.items()}
        if films["--bg-secondary"]:
            rgb, alpha = films["--bg-secondary"]
            secondary = composite(rgb, alpha, page)
            paint["--bg-secondary"] = css_rgba(rgb, alpha)
        for role in ("--bg-tertiary", "--surface", "--bg-chrome"):
            if not films[role] or (role == "--bg-chrome" and rail is not None):
                continue
            rgb, alpha = films[role]
            base = page if role in over_page else secondary
            value = composite(rgb, alpha, base)
            paint[role] = css_rgba(rgb, alpha)
            if role == "--bg-tertiary":
                tertiary = value
            elif role == "--surface":
                surface = value
            else:
                chrome = value

    # Every surface the SHARED ink tokens land on. A branded rail is excluded on
    # purpose: it is the inverse of the page, so demanding one ink clear 4.5:1
    # on both a #eef1f0 ground and a #0b3d5c navy has no solution — the search
    # below would walk every text token to pure black and still fail. The rail
    # gets its own ink instead, computed against itself, which is the only
    # reason it can be allowed onto a neutral at all.
    surfaces = [page, secondary, tertiary, surface]
    if rail is None:
        surfaces.append(chrome)

    # The lit ground, at its brightest point, for every pack that has one — the
    # aurora glow and the softer wash alike. A gradient is a background IMAGE,
    # and `getComputedStyle` reports background-COLOR, so the live browser sweep
    # is blind to it. Bounding it here is the only place it gets bounded, and
    # every text token below is then pushed until it clears on this.
    ground_alpha = (GLOW_ALPHA if glass
                    else (WASH_BASE + WASH_SCALE * soft) * (1.0 if dark else LIGHT_WASH_FACTOR)
                    if soft >= WASH_MIN_SOFTNESS else 0.0)
    glow_seed = next(
        (rgb for rgb in (_parse(tokens.get(name) or "")
                         for name in ACCENT_SOURCES["--accent-primary"])
         if rgb is not None), None)
    if glow_seed is not None and ground_alpha > 0:
        surfaces.append(composite(glow_seed, ground_alpha, page))

    if glass:
        # The palette floats over the editor, and the editor is the ground. Both
        # ends of that ground go in — the bare page, and the page under the
        # brightest part of the glow — so the text loop below guarantees 4.5:1
        # on a palette wherever it is opened.
        surfaces += [composite(surface, GLASS_PANEL_ALPHA, ground)
                     for ground in {page, surfaces[-1]}]

    # The pack's own line colour, held inside a contrast band. Unlike a surface,
    # a border has nothing painted on it, so this cannot cost legibility — and
    # it is most of what makes `industrial-*` read as hard-edged next to the
    # aurora pair, whose translucent borders are refused and fall back here.
    # A rule drawn at ONE contrast band for all ten packs is most of why the
    # chrome read alike. An HMI's furniture is hard-edged and a soft theme's is
    # barely there, so the band is interpolated on the pack's own softness:
    # `industrial-day-cyan` (0.06) gets a crisp line, `nord-*` (1.00) a whisper.
    lo_light, hi_light = _lerp(2.2, 1.3, soft), _lerp(4.6, 2.6, soft)
    lo_strong, hi_strong = _lerp(3.4, 1.9, soft), _lerp(7.0, 3.6, soft)
    pack_border = border_from_pack(tokens, page, dark, lo_light, hi_light)
    if pack_border is not None:
        border = pack_border
    else:
        border = clamp_contrast(border, page, lo_light, hi_light, dark)
    strong = clamp_contrast(border, page, lo_strong, hi_strong, dark)
    border_css, strong_css = _hex(border), _hex(strong)

    # A luminous edge, where the pack draws one. `border_from_pack` refuses a
    # translucent border and falls back to the ramp — right while the surfaces
    # were opaque, wrong now: on a translucent pane the 22%-white hairline is
    # where the light catches the edge, and it is most of what reads as glass.
    # The strong variant is the same light, turned up, not a different colour.
    edge = hairline(tokens) if glass else None
    if edge:
        rgb, alpha = edge
        border_css = css_rgba(rgb, alpha)
        strong_css = css_rgba(rgb, min(1.0, alpha * 1.9))

    # Frosted glass, and ONLY on the layers that float over content: the palette
    # and the dialogs. Never behind the editor — blurring the ground under
    # syntax highlighting is how a theme becomes unreadable, and the code
    # surface stays opaque in every one of the ten.
    out = {
        "--bg-primary": _hex(page),
        "--bg-secondary": paint["--bg-secondary"],
        "--bg-tertiary": paint["--bg-tertiary"],
        "--bg-chrome": paint["--bg-chrome"],
        "--surface": paint["--surface"],
        "--blur-panel": "blur(22px) saturate(1.4)" if glass else "none",
        "--glass-panel": glass_panel(surface, glass),

        # The rail colour as an OPAQUE value. Anything that has to occlude what
        # scrolls under it — a sticky group heading — cannot use the film: at 6%
        # the rows travel visibly behind the heading that is meant to cover
        # them. Identical to --bg-secondary on the seven non-glass packs.
        "--bg-solid": _hex(secondary),
        "--border-light": border_css,
        "--border-strong": strong_css,
        "--text-primary": text_at(page, TEXT_TARGETS["primary"], dark),
        "--text-secondary": text_at(page, TEXT_TARGETS["secondary"], dark),
        "--text-muted": text_at(page, TEXT_TARGETS["muted"], dark),

        # The activity bar's OWN ink, measured against the activity bar.
        #
        # Identical to the shared tokens on the eight packs whose rail is a step
        # off their own page — so this costs those eight nothing — and the whole
        # reason `finance-ledger` and `leather-parchment-tan` can keep the dark
        # rail that is the loudest thing about either design.
        "--text-chrome": text_at(chrome, TEXT_TARGETS["muted"], rail_dark),
        "--text-chrome-active": text_at(chrome, TEXT_TARGETS["primary"], rail_dark),
    }

    # The text tokens are measured against the PAGE, but they also paint on the
    # tree (secondary), a hovered row (tertiary) and the activity bar (chrome),
    # every one of which is closer to them. Push each until it clears the bar on
    # the worst of them. This is not belt and braces: the ramp above is now
    # WIDER on the flat themes than it was in 1.6.x, so the worst surface for a
    # muted label moved.
    ink = (1.0, 1.0, 1.0) if dark else (0.0, 0.0, 0.0)
    for role in ("--text-primary", "--text-secondary", "--text-muted"):
        base = _parse(out[role])
        for i in range(0, 101):
            candidate = _mix(base, ink, i / 100)
            if all(_ratio(candidate, s) >= MIN_TEXT_CONTRAST for s in surfaces):
                out[role] = _hex(candidate)
                break

    # The pack's `font.body` is NOT copied through.
    #
    # A Perspective pack names a typeface as part of a brand — `newsprint-night`
    # asks for Georgia — and applying that to an IDE renders the file tree, the
    # tab strip and every button in a serif. VS Code themes have never changed
    # the UI font, for exactly this reason: a theme here is a palette. The one
    # stack lives in index.css, beside the mono stack it has to line up with.

    for role, names in ACCENT_SOURCES.items():
        minimum = 3.0 if role == "--syntax-comment" else MIN_ACCENT_CONTRAST
        floor = SIGNAL_CHROMA_MIN if role in SIGNAL_ROLES else 0.0
        colour, adjusted = pick_legible(tokens, names, surfaces, dark, minimum,
                                        floor)
        out[role] = colour
        if adjusted:
            report.append(f'  {pack["id"]}: {role} nudged to {colour} '
                          f'(no pack token cleared {minimum}:1 on all surfaces)')

    differentiate_signals(out, surfaces, dark, pack["id"], report)
    differentiate_syntax(out, surfaces, dark, pack["id"], report)

    # Emitted after the accents, because the glow is painted in the theme's own
    # brand colour and that colour is not final until it has been made legible.
    out["--page-glow"] = page_glow(tokens, page, glass, dark, out["--accent-primary"])

    accent = out["--accent-primary"]
    out["--accent-primary-bg"] = accent_bg(accent, dark)

    # The accent AS IT PAINTS ON THE ACTIVITY BAR.
    #
    # `finance-ledger` resolves its accent to #0b3d5c and its rail is #0b3d5c —
    # the same navy, because the pack brands both with one colour. The active
    # marker and the focus ring drawn in it were invisible against it. Lifted to
    # 3.5:1 rather than 4.5:1 because these are a 3px bar and an icon outline,
    # not text; on the eight packs whose rail is a step off their own page it
    # already clears and comes back unchanged.
    accent_rgb = _parse(accent)
    on_rail, _ = lift_to_contrast(accent_rgb, [chrome], 3.5, not rail_dark)
    out["--accent-chrome"] = _hex(on_rail)

    # The ink that goes ON the accent — a filled primary button, and nothing
    # else in this app fills with the accent.
    #
    # It was white, hardcoded, from 1.1.0. Right for nine of the ten and wrong
    # for `newsprint-night`, whose brand IS paper: its accent resolves to
    # #e8e2d6 and the Run button shipped as white text on a near-white fill,
    # unreadable, through every release since. Nothing measured it, because the
    # theme sweep reads a colour off the element and a literal in a stylesheet
    # is not a token any theme can move.
    on_accent = (1.0, 1.0, 1.0)
    if _ratio((0.0, 0.0, 0.0), accent_rgb) > _ratio(on_accent, accent_rgb):
        on_accent = (0.0, 0.0, 0.0)
    out["--accent-ink"] = _hex(on_accent)

    # ---- geometry ---------------------------------------------------------
    #
    # Taken from the pack in full, because this is the half that cannot hurt.
    # Each token has exactly one job in the IDE, and each is clamped to the
    # band that job can wear — see _px.
    row_height, control_height = density(tokens)
    out.update({
        # Controls: buttons, inputs, selects, tabs.
        "--radius": _px(tokens.get("radius.control"), 0, 8, "3px"),
        # Framed and floating surfaces: dialogs, the palette, the layout menu.
        # Ceiling 18px — the roundest pack — not 12px, which flattened the five
        # packs above it onto one value. This is the token the eye reads first,
        # because the palette is the biggest floating surface in the app.
        "--radius-panel": _px(tokens.get("radius.card"), 0, 18, "3px"),
        # List rows: the tree, the outline, palette and search results. Kept
        # tighter than the panel radius — a full-width row takes the round at
        # both ends, and the rows are what the eye scans down.
        #
        # The ceiling was 6px until 1.7.1 and SEVEN of the ten packs exceeded
        # it, so seven themes came out with identical rows. Measured in the
        # browser, not read off the packs: the tokens differed on paper and the
        # painted values did not (Nigel: "they all look the same as before").
        "--radius-row": _px(tokens.get("radius.nav"), 0, 8, "0"),
        # The rule under a strip or a head. Only `finance-ledger` doubles it,
        # and a ledger drawn with a heavier rule is exactly what it is for.
        "--rule-width": _px(tokens.get("border.table-header-width"), 1, 2, "1px"),
        # The bar that marks the active tab, activity item and inherited note.
        # `newsprint-night` 2px, `industrial-*` 4px.
        "--marker-width": _px(tokens.get("border.alarm-bar-width"), 2, 4, "2px"),
        # Elevation, in the pack's own shadow language. `none` where the pack
        # names no shadow, which is four of the ten and is deliberate.
        "--shadow-card": lit_edge(elevate(tokens.get("shadow.card"), 1.0, 1.0, 0.0, 0.5), edge),
        # Tripled and floored: a floating layer that casts the same 0.06 alpha
        # a flat card does is a token nobody can see.
        "--shadow-popup": lit_edge(
            elevate(tokens.get("shadow.card"), 3.0, 2.6, 0.22, 0.5,
                    floors=SHADOW_FLOORS), edge),
        "--shadow-control": brand_glow(tokens.get("shadow.button"), accent),
        "--row-height": row_height,
        "--control-height": control_height,
    })

    lines = [f'/* {pack["label"]} — {"dark" if dark else "light"} */']
    # `:root[data-theme=...]`, not a bare attribute selector. `:root` and
    # `[data-theme]` have IDENTICAL specificity, so a bare selector only wins on
    # source order — and index.css is bundled after this file, so the theme was
    # silently overridden. Measured in the browser 01/09/2026: data-theme
    # changed and not one colour did.
    lines.append(f':root[data-theme="{pack["id"]}"] {{')
    # color-scheme is not decoration. Without it Chrome's "auto dark mode for
    # web contents" repaints the page's own colours, and no headless check can
    # reproduce it. This has cost the estate four releases.
    lines.append(f'  color-scheme: {"dark" if dark else "light"};')
    for key, value in out.items():
        lines.append(f"  {key}: {value};")
    lines.append("}")
    return "\n".join(lines), out


def generate(packs_dir: pathlib.Path) -> str:
    files = sorted(packs_dir.glob("*.json"))
    if not files:
        raise SystemExit(f"No packs found in {packs_dir}")
    packs = [json.loads(f.read_text()) for f in files]
    report: list[str] = []
    header = (
        "/*\n"
        " * GENERATED by tools/build-themes.py from the ignition-themes packs.\n"
        " * Do not edit by hand — edit the pack and regenerate, or the IDE and the\n"
        " * Perspective sessions beside it drift apart.\n"
        " *\n"
        " * The NEUTRALS are derived from each pack's page colour, not mapped from\n"
        " * its surfaces: Perspective's surfaces are semantic (a 'sidebar' is branded\n"
        " * chrome, dark even in a light theme) and mapping them onto a lightness\n"
        " * ramp made five of these ten themes illegible. The pack supplies the\n"
        " * accent and syntax hues, each checked against every surface it lands on.\n"
        " *\n"
        " * The GEOMETRY is taken in full — radius, rule and marker widths, shadow,\n"
        " * row and control heights — because a radius cannot make text illegible.\n"
        " * It is what makes `newsprint-night` square, flat and shadowless beside a\n"
        " * rounded, softly shadowed `aurora-teal` instead of the same shell twice.\n"
        " *\n"
        f" * {len(packs)} themes.\n"
        " */\n"
    )
    blocks = [block(p, report) for p in packs]

    # Two themes that generate the same eighteen values are one theme with two
    # names, and the picker then offers a choice that does nothing. This is the
    # 1.2.0 aurora bug expressed as an assertion — it shipped precisely because
    # nothing compared one theme's output against another's.
    seen: dict[str, str] = {}
    for pack, (_, out) in zip(packs, blocks):
        key = "|".join(f"{k}={v}" for k, v in sorted(out.items()))
        if key in seen:
            raise SystemExit(
                f"Themes '{seen[key]}' and '{pack['id']}' generate identical palettes. "
                "Their packs differ only in tokens this generator ignores — widen "
                "ACCENT_SOURCES or the accent tint rather than shipping two names "
                "for one theme."
            )
        seen[key] = pack["id"]

    # Two properties that were BOTH broken while every check was green, and are
    # therefore assertions rather than intentions. Measured against 1.10.0's own
    # output, which fails both: min ground chroma 3 (bar 18) and worst syntax
    # separation 6.2 (bar 28).
    for pack, (_, out) in zip(packs, blocks):
        ground = _parse(out["--bg-primary"])
        floor = GROUND_CHROMA_DARK if pack["dark"] else GROUND_CHROMA_LIGHT
        if chroma(ground) < floor - 1e-6:
            raise SystemExit(
                f"{pack['id']}: its ground carries a chroma of "
                f"{chroma(ground) * 255:.0f}/255, under the {floor * 255:.0f} floor. "
                "A ground that colourless makes the theme one more shade of grey — "
                "see saturate_ground, which exists to prevent exactly this."
            )
        gap = _ratio(_parse(out["--accent-ink"]), _parse(out["--accent-primary"]))
        if gap < MIN_TEXT_CONTRAST:
            raise SystemExit(
                f"{pack['id']}: --accent-ink {out['--accent-ink']} reads at only "
                f"{gap:.1f}:1 on --accent-primary {out['--accent-primary']}. That is "
                "the label on a filled primary button; neither black nor white "
                "clears here, so the accent itself needs moving."
            )
        # A signal that cannot signal. `leather-night-tan` and
        # `leather-parchment-tan` painted --error and --success the SAME hex,
        # and `industrial-day-cyan` painted both grey; all three were green
        # under every check this file had, because nothing ever compared the
        # two roles or asked whether either was a colour at all.
        for role in sorted(SIGNAL_ROLES):
            saturation = _to_hsl(_parse(out[role]))[1]
            if saturation < SIGNAL_SATURATION_MIN:
                raise SystemExit(
                    f"{pack['id']}: {role} resolves to {out[role]}, a saturation of "
                    f"{saturation:.2f} under the {SIGNAL_SATURATION_MIN:.2f} floor. "
                    "A grey error is not a quieter error, it is no error — the pack "
                    "token it came from is ink for a chip, not the chip's colour. "
                    "See SIGNAL_ROLES."
                )
        for first, second in itertools.combinations(sorted(SIGNAL_ROLES), 2):
            gap = _separation(_parse(out[first]), _parse(out[second]))
            if gap < SYNTAX_SEPARATION:
                raise SystemExit(
                    f"{pack['id']}: {first} ({out[first]}) and {second} "
                    f"({out[second]}) separate by only {gap:.1f}, under "
                    f"{SYNTAX_SEPARATION}. An error and a success a reader cannot "
                    "tell apart is the one failure a status colour must not have."
                )

        roles = [r for r in SYNTAX_PRIORITY if r in out]
        for first, second in itertools.combinations(roles, 2):
            gap = _separation(_parse(out[first]), _parse(out[second]))
            if gap < SYNTAX_SEPARATION:
                raise SystemExit(
                    f"{pack['id']}: {first} ({out[first]}) and {second} "
                    f"({out[second]}) separate by only {gap:.1f}, under "
                    f"{SYNTAX_SEPARATION}. They are one colour with two names, and "
                    "highlighting that does not distinguish is worse than none. "
                    "differentiate_syntax should have pulled them apart — widen its "
                    "arc or its weight fallback rather than lowering the bar."
                )

    css = header + "\n\n".join(text for text, _ in blocks) + "\n"
    if report:
        print(f"Contrast adjustments ({len(report)}):", file=sys.stderr)
        for line in report:
            print(line, file=sys.stderr)
    return css


def theme_list_ts(packs: list[dict]) -> str:
    """
    The TypeScript theme list.

    Emitted from the SAME packs as the CSS, in the same run, because the failure
    otherwise is silent: a name in the picker with no matching CSS block gives
    the viewer an option that does nothing at all.
    """
    lines = [
        "/**",
        " * GENERATED by tools/build-themes.py. Do not edit by hand.",
        " *",
        " * The picker's list, emitted from the same packs as themes.generated.css so",
        " * every option here has a stylesheet block to match.",
        " */",
        "export interface ThemeChoice {",
        "  id: string;",
        "  label: string;",
        "  dark: boolean;",
        "}",
        "",
        "export const THEMES: ThemeChoice[] = [",
    ]
    for pack in packs:
        label = json.dumps(pack["label"])
        dark = "true" if pack["dark"] else "false"
        lines.append(f"  {{ id: '{pack['id']}', label: {label}, dark: {dark} }},")
    lines += [
        "];",
        "",
        "export type ThemeId = (typeof THEMES)[number]['id'];",
        "",
        "/**",
        " * The default. A dark theme, because the editor is the whole page and this",
        " * is the closest of the ten to the palette the app shipped with in 1.0.",
        " */",
        "export const DEFAULT_THEME: ThemeId = 'nord-dark-frost';",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    here = pathlib.Path(__file__).resolve().parent.parent
    parser.add_argument(
        "--packs",
        type=pathlib.Path,
        default=here.parent.parent / "ignition-themes" / "packs",
    )
    parser.add_argument(
        "--out", type=pathlib.Path, default=here / "web" / "src" / "themes.generated.css"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the committed file is out of date",
    )
    args = parser.parse_args()

    css = generate(args.packs)
    packs = [json.loads(f.read_text()) for f in sorted(args.packs.glob("*.json"))]
    ts = theme_list_ts(packs)
    ts_out = args.out.parent / "themes.ts"

    if args.check:
        stale = []
        for path, wanted in ((args.out, css), (ts_out, ts)):
            if (path.read_text() if path.exists() else "") != wanted:
                stale.append(str(path))
        if stale:
            print(
                "Out of date, rerun tools/build-themes.py: " + ", ".join(stale),
                file=sys.stderr,
            )
            return 1
        print(f"{args.out.name} and {ts_out.name} are up to date")
        return 0

    args.out.write_text(css)
    ts_out.write_text(ts)
    print(f"Wrote {args.out} and {ts_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
