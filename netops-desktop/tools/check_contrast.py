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

import sys

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
    failures = audit(DARK) + audit(LIGHT)
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