#!/usr/bin/env python3
"""WCAG contrast guard for the BlackNet palette.

The palette follows the two ergonomic schemes agreed for the shell:

  Opsi A  Deep Slate Dark  (night)  bg #1E222A  panel #252B35  text #E1E4EA  accent #569CD6
  Opsi B  Warm Off-White   (day)    bg #F4F5F7  panel #E5E7EB  text #1F2937  accent #0D9488

Pure black and pure white are deliberately absent: they cause halation in the
dark scheme and glare in the light one. This script fails when a documented pair
drops below its WCAG target, so a palette tweak cannot silently regress
accessibility.

    python3 tools/check_contrast.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

DARK = {
    "name": "Deep Slate Dark (Opsi A, night)",
    "bg": "#1E222A",
    "surface": "#252B35",
    "raised": "#2B323D",
    "line": "#3A4250",
    "line_strong": "#727E96",
    "text": "#E1E4EA",
    "muted": "#A9B2C0",
    "accent": "#569CD6",
    "accent_fill": "#4A8CC4",
    "accent_ink": "#0C1622",
    "ok": "#6FBF73",
    "warn": "#D6B24C",
    "bad": "#E06C62",
}

LIGHT = {
    "name": "Warm Off-White (Opsi B, day)",
    "bg": "#F4F5F7",
    "surface": "#E5E7EB",
    "raised": "#FAFBFC",
    "line": "#D3D7DE",
    "line_strong": "#6B7280",
    "text": "#1F2937",
    "muted": "#566173",
    "accent": "#0D9488",
    "accent_fill": "#0A6E66",
    "accent_ink": "#F2FAF8",
    "ok": "#2E7D4F",
    "warn": "#8A6A12",
    "bad": "#B3382E",
}

# (foreground, background, minimum ratio, requirement)
PAIRS = [
    ("text", "bg", 7.0, "AAA body text"),
    ("text", "surface", 7.0, "AAA body text"),
    ("text", "raised", 7.0, "AAA body text"),
    ("muted", "bg", 4.5, "AA small text"),
    ("muted", "surface", 4.5, "AA small text"),
    ("muted", "raised", 4.5, "AA small text"),
    ("accent", "bg", 3.0, "AA non-text (icon, focus ring)"),
    ("accent", "surface", 3.0, "AA non-text (icon, focus ring)"),
    ("accent", "raised", 3.0, "AA non-text (icon, focus ring)"),
    ("accent_ink", "accent_fill", 4.5, "AA text on accent fill"),
    ("ok", "bg", 4.5, "AA status text"),
    ("warn", "bg", 4.5, "AA status text"),
    ("bad", "bg", 4.5, "AA status text"),
    ("line_strong", "bg", 3.0, "AA control boundary"),
    ("line_strong", "surface", 3.0, "AA control boundary"),
    ("line_strong", "raised", 3.0, "AA control boundary"),
    ("line", "bg", 1.0, "decorative divider"),
]

TAB_MIN_DELTA = 1.12


def luminance(hex_color: str) -> float:
    value = hex_color.lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    channels = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [
        c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        for c in channels
    ]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def ratio(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


# --- CSS token audit -------------------------------------------------------
#
# The palettes above were the only thing this script checked, so a stylesheet
# could ship any colour it liked. newtab.css already did: its --line-strong sat
# at 1.46:1 on --raised, well under the 3:1 that palette.css holds, and nothing
# noticed. Every renderer stylesheet that defines its own tokens is now parsed
# and held to the same PAIRS table.
#
# Token names are normalised dashes -> underscores because PAIRS spells them
# line_strong while CSS spells --line-strong. Comparing them verbatim skips
# those pairs silently, which is the bug this section exists to prevent.

RENDERER = Path(__file__).resolve().parents[1] / "src" / "renderer"

_HEX = r"#[0-9a-fA-F]{3,6}"


def _norm(name: str) -> str:
    return name.strip().replace("-", "_")


def _base_scheme(css: str) -> str:
    """Which scheme a bare :root block paints when the OS states no preference.

    `color-scheme: light dark` makes light the default; `dark light` makes dark
    the default. Getting this backwards silently swaps a page's whole palette.
    """
    m = re.search(r"color-scheme:\s*([^;]+);", css)
    if not m:
        return "light"
    first = m.group(1).split()[0].strip().lower()
    return first if first in ("light", "dark", "normal") else "light"


def _strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def iter_blocks(css: str, preludes: tuple[str, ...] = ()):
    """Yield (enclosing_preludes, body) for every brace-matched block.

    Regexes cannot find the end of a :root block reliably - the same file may
    write it across lines or all on one. Walk the braces instead, and carry the
    enclosing preludes so a :root nested in @media can be told from a bare one.

    Recurses into each body: a block's body still contains its nested blocks,
    and skipping that second pass silently drops the @media (prefers-color-scheme:
    light) override that a page uses for its light half.
    """
    i = 0
    start = 0
    while i < len(css):
        ch = css[i]
        if ch == "{":
            depth = 1
            j = i + 1
            while j < len(css) and depth:
                if css[j] == "{":
                    depth += 1
                elif css[j] == "}":
                    depth -= 1
                j += 1
            prelude = css[start:i]
            body = css[i + 1:j - 1]
            yield list(preludes) + [prelude], body
            yield from iter_blocks(body, tuple(preludes) + (prelude,))
            i = j
            start = j
            continue
        if ch in ";}":
            start = i + 1
        i += 1


def css_schemes(css: str) -> dict[str, dict[str, str]]:
    """Extract {scheme: {token: hex}} from a stylesheet.

    Handles both idioms in this repo:
      - palette.css : --x: light-dark(#light, #dark)
      - newtab.css  : a bare :root block for the default scheme plus an
                      @media (prefers-color-scheme: light) override
    Only :root blocks are read: selectors like .foo or body never set the
    page-wide tokens this audit cares about.
    """
    css = _strip_comments(css)
    schemes: dict[str, dict[str, str]] = {}
    base = _base_scheme(css)

    for preludes, body in iter_blocks(css):
        if not any(re.search(r"(^|\W):root\b", p) for p in preludes):
            continue
        enclosing = " ".join(preludes[:-1])
        if re.search(r"prefers-color-scheme\s*:\s*light", enclosing):
            scheme = "light"
        elif re.search(r"prefers-color-scheme\s*:\s*dark", enclosing):
            scheme = "dark"
        else:
            scheme = base
        target = schemes.setdefault(scheme, {})
        for decl in re.finditer(rf"--([\w-]+)\s*:\s*({_HEX})\s*;", body):
            target[_norm(decl.group(1))] = decl.group(2).lower()
        for decl in re.finditer(
            rf"--([\w-]+)\s*:\s*light-dark\(\s*({_HEX})\s*,\s*({_HEX})\s*\)", body
        ):
            name = _norm(decl.group(1))
            schemes.setdefault("light", {})[name] = decl.group(2).lower()
            schemes.setdefault("dark", {})[name] = decl.group(3).lower()
    return schemes


def audit_css(path: Path) -> list[str]:
    """Hold one stylesheet's own tokens to the same PAIRS thresholds."""
    css = path.read_text(encoding="utf-8")
    schemes = css_schemes(css)
    if not schemes:
        print(f"\n{path.name}: no :root tokens, inherits from palette.css (skipped)")
        return []

    failures: list[str] = []
    print(f"\n{path.name} (css tokens, default scheme: {_base_scheme(css)})")
    for scheme in sorted(schemes):
        tokens = schemes[scheme]
        if not tokens:
            continue
        print(f"  -- {scheme} --")
        for fg_key, bg_key, minimum, requirement in PAIRS:
            if fg_key not in tokens or bg_key not in tokens:
                continue
            value = ratio(tokens[fg_key], tokens[bg_key])
            ok = value >= minimum
            print(f"  [{'ok  ' if ok else 'FAIL'}] {fg_key:>11} on {bg_key:<11}"
                  f" {value:5.2f}:1  (min {minimum}:1, {requirement})")
            if not ok:
                failures.append(
                    f"{path.name} [{scheme}]: {fg_key} on {bg_key} = {value:.2f}:1 < {minimum}:1")
    return failures


def self_test() -> list[str]:
    """Prove the CSS audit actually fires before trusting a clean run.

    Guards the failure mode where a naming mismatch makes every check skip and
    the tool reports success while auditing nothing.
    """
    problems: list[str] = []
    good = """
      :root { color-scheme: dark light;
        --bg: #1e2129; --surface: #272c37; --raised: #333a48;
        --line-strong: #8290a9; --text: #eceef3; --muted: #a8b0c0;
        --line: #3a4150; }
      @media (prefers-color-scheme: light) {
        :root {
          --bg: #f4f5f8; --surface: #ffffff; --raised: #eceef3;
          --line-strong: #737c94; --text: #1b1f2a; --muted: #566074;
          --line: #d9dce4; }
      }
    """
    bad = good.replace("#8290a9", "#505a6d")

    if audit_scheme_map(css_schemes(good), "self-test good"):
        problems.append("self-test: a compliant stylesheet was reported as failing")
    if not audit_scheme_map(css_schemes(bad), "self-test bad"):
        problems.append("self-test: a 2.32:1 control boundary was NOT reported")
    if not css_schemes(":root { --bg: #fff; }"):
        problems.append("self-test: bare :root tokens were not parsed")
    if not css_schemes(":root { --bg: light-dark(#f4f5f7, #1e222a); }").get("dark"):
        problems.append("self-test: light-dark() was not expanded")

    schemes = css_schemes(good)
    for want in ("dark", "light"):
        if want not in schemes:
            problems.append(f"self-test: the {want} :root block was never reached")
        elif "bg" not in schemes[want]:
            problems.append(f"self-test: {want} scheme has no tokens")
    if schemes.get("dark", {}).get("bg") == schemes.get("light", {}).get("bg"):
        problems.append("self-test: both schemes resolved to the same tokens")
    return problems


def audit_scheme_map(schemes: dict[str, dict[str, str]], label: str) -> list[str]:
    """Return failures only. Quiet variant used by the self-test."""
    failures: list[str] = []
    for scheme, tokens in schemes.items():
        for fg_key, bg_key, minimum, requirement in PAIRS:
            if fg_key not in tokens or bg_key not in tokens:
                continue
            if ratio(tokens[fg_key], tokens[bg_key]) < minimum:
                failures.append(
                    f"{label} [{scheme}]: {fg_key} on {bg_key} "
                    f"= {ratio(tokens[fg_key], tokens[bg_key]):.2f}:1 < {minimum}:1")
    return failures


def audit(palette: dict[str, str]) -> list[str]:
    failures: list[str] = []
    print(f"\n{palette['name']}")
    for fg_key, bg_key, minimum, requirement in PAIRS:
        value = ratio(palette[fg_key], palette[bg_key])
        ok = value >= minimum
        print(f"  [{'ok  ' if ok else 'FAIL'}] {fg_key:>11} on {bg_key:<11}"
              f" {value:5.2f}:1  (min {minimum}:1, {requirement})")
        if not ok:
            failures.append(
                f"{palette['name']}: {fg_key} on {bg_key} = {value:.2f}:1 < {minimum}:1")
    # Active and inactive tabs must be told apart without relying on hue alone.
    delta = ratio(palette["surface"], palette["bg"])
    ok = delta >= TAB_MIN_DELTA
    print(f"  [{'ok  ' if ok else 'FAIL'}] active tab vs inactive tab  {delta:5.2f}:1"
          f"  (min {TAB_MIN_DELTA}:1)")
    if not ok:
        failures.append(
            f"{palette['name']}: active/inactive tab contrast {delta:.2f}:1"
            f" < {TAB_MIN_DELTA}:1")
    return failures


def main() -> int:
    print("auditor self-test")
    guard_problems = self_test()
    if guard_problems:
        print("  [FAIL] the contrast auditor itself is broken:")
        for line in guard_problems:
            print(f"  - {line}")
        return 1
    print("  [ok  ] compliant stylesheets pass, failing ones are caught")

    failures = audit(DARK) + audit(LIGHT)
    for path in sorted(RENDERER.glob("*.css")):
        failures += audit_css(path)
    print()
    if failures:
        print("contrast budget violated:")
        for line in failures:
            print(f"  - {line}")
        return 1
    print("contrast budget met (WCAG AA; AAA for body text)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())