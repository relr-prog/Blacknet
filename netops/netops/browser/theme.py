"""Theme engine: dark/light, per-site colour overrides, reader mode, blocking.

Themes are applied by injecting CSS into every page, so the engine's own chrome
is irrelevant: the page itself is restyled.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..security import validate_hostname

__all__ = ["ThemeStore", "Theme", "PRESETS", "apply_theme"]

_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_FONT = re.compile(r"""^[\w\s,'"()\-]{1,80}$""")


def _fields(entry: dict) -> dict:
    """Drop internal keys (prefixed with _) before building a Theme."""
    return {key: value for key, value in entry.items() if not key.startswith("_")}


PRESETS: dict[str, dict[str, str]] = {
    "midnight": {"bg": "#0c0f16", "fg": "#dfe6f2", "accent": "#4fc3f7", "muted": "#7d8ba3", "link": "#7c5cff"},
    "paper": {"bg": "#faf7f2", "fg": "#1b1b1b", "accent": "#b45309", "muted": "#6b6b6b", "link": "#1d4ed8"},
    "forest": {"bg": "#0f1a14", "fg": "#dff3e5", "accent": "#34d399", "muted": "#7ea894", "link": "#a3e635"},
    "sunset": {"bg": "#1a1016", "fg": "#ffe9e3", "accent": "#fb923c", "muted": "#b08999", "link": "#f472b6"},
    "contrast": {"bg": "#000000", "fg": "#ffffff", "accent": "#ffff00", "muted": "#cccccc", "link": "#00ffff"},
    "sepia": {"bg": "#f4ecd8", "fg": "#3b2f2f", "accent": "#8b5a2b", "muted": "#7a6a5a", "link": "#8b4513"},
}


@dataclass
class Theme:
    name: str = "midnight"
    mode: str = "dark"                 # dark | light | auto
    colors: dict[str, str] = field(default_factory=dict)
    font_family: str | None = None
    font_size: int | None = None
    line_height: float | None = None
    max_width: int | None = None
    hide_images: bool = False
    hide_ads: bool = False
    dim_videos: bool = False
    reader_mode: bool = False
    force_dark: bool = True
    selector_scope: str = "html"

    def validate(self) -> "Theme":
        if self.mode not in ("dark", "light", "auto"):
            raise ValueError("theme.mode must be dark, light or auto")
        if self.name not in PRESETS:
            raise ValueError(f"theme.name must be one of {sorted(PRESETS)}")
        if self.font_family and not _FONT.match(self.font_family):
            raise ValueError("theme.font_family may only contain letters, spaces and punctuation")
        if self.font_size is not None and not 10 <= self.font_size <= 32:
            raise ValueError("theme.font_size must be between 10 and 32")
        if self.line_height is not None and not 1.0 <= self.line_height <= 2.5:
            raise ValueError("theme.line_height must be between 1.0 and 2.5")
        if self.max_width is not None and not 480 <= self.max_width <= 2560:
            raise ValueError("theme.max_width must be between 480 and 2560")
        for key, value in self.colors.items():
            if not _HEX.match(str(value)):
                raise ValueError(f"theme colour {key}={value!r} must be a hex colour")
        return self

    def to_css(self) -> str:
        base = dict(PRESETS.get(self.name, PRESETS["midnight"]))
        base.update({k: str(v) for k, v in self.colors.items()})
        rules = [
            "html,body{background:%s!important;color:%s!important}" % (base["bg"], base["fg"]),
            "a,a:link,a:visited{color:%s!important}" % base["link"],
            "button,input,select,textarea{border-color:%s!important}" % base["muted"],
            "::selection{background:%s!important;color:%s!important}" % (base["accent"], base["bg"]),
            "code,pre,kbd{background:%s33!important;color:%s!important}" % (base["fg"], base["fg"]),
        ]
        if self.font_family:
            rules.append(
                "html,body,input,button,textarea,select{font-family:%s!important}" % self.font_family
            )
        if self.font_size:
            rules.append("html{font-size:%dpx!important}" % self.font_size)
        if self.line_height:
            rules.append("body{line-height:%.2f!important}" % self.line_height)
        if self.max_width:
            rules.append(
                "body>*{max-width:%dpx!important;margin-left:auto!important;margin-right:auto!important}"
                % self.max_width
            )
        if self.hide_images:
            rules.append("img,picture,video,svg.image{visibility:hidden!important;max-height:1px!important}")
        if self.dim_videos:
            rules.append("video{opacity:.45!important}video:hover{opacity:1!important}")
        if self.hide_ads:
            rules.append(
                "[id*='banner'],[class*='ad-'],[class*='advert'],[id*='-ad-'],"
                "[class*='sponsored'],iframe[src*='doubleclick'],iframe[src*='adsystem']"
                "{display:none!important}"
            )
        if self.reader_mode:
            rules.append(
                "body>*:not(main):not(article):not(#content):not(.post):not([role=main])"
                "{display:none!important}"
                "body{max-width:720px!important;margin:2rem auto!important;padding:0 1rem!important;"
                "background:#fdfdfb!important;color:#161616!important;font-size:18px!important;"
                "line-height:1.7!important;font-family:Georgia,serif!important}"
            )
        if self.force_dark and self.mode in ("dark", "auto"):
            rules.append(
                "img,video,canvas,svg,iframe,embed,object,input,textarea,select,"
                "button,.btn,.card,.panel,.modal{filter:invert(0.92) hue-rotate(180deg)!important}"
            )
        return "\n".join(rules)


class ThemeStore:
    """Persists the global theme, per-site overrides and button presets."""

    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / "themes.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._data: dict[str, Any] = {"global": {}, "sites": {}, "buttons": {}}
        self._load()

    def _load(self) -> None:
        if self.path.is_file():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self._data.update({k: v for k, v in loaded.items() if isinstance(v, dict)})
            except (json.JSONDecodeError, OSError):
                pass

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(self.path)

    # ---------------------------------------------------------------- global
    def get_global(self) -> dict:
        entry = self._data.get("global", {})
        theme = Theme(**_fields(entry))
        return {
            "theme": theme.__dict__,
            "css": theme.to_css(),
            "presets": PRESETS,
            "updated_at": entry.get("_updated_at", 0),
        }

    def set_global(self, **changes: Any) -> dict:
        current = Theme(**_fields(self._data.get("global", {})))
        for key, value in changes.items():
            if not hasattr(current, key):
                raise ValueError(f"unknown theme field {key!r}")
            setattr(current, key, value)
        current.validate()
        self._data["global"] = {**current.__dict__, "_updated_at": time.time()}
        self._save()
        return self.get_global()

    # ------------------------------------------------------------- per site
    def site_theme(self, host: str) -> dict:
        entry = self._data["sites"].get(host.lower(), {})
        theme = Theme(**_fields(entry))
        return {
            "host": host,
            "theme": theme.__dict__,
            "css": theme.to_css(),
            "updated_at": entry.get("_updated_at", 0),
        }

    def set_site_theme(self, host: str, **changes: Any) -> dict:
        host = (host or "").lower().strip()
        validate_hostname(host)
        current = Theme(**_fields(self._data["sites"].get(host, {})))
        for key, value in changes.items():
            if not hasattr(current, key):
                raise ValueError(f"unknown theme field {key!r}")
            setattr(current, key, value)
        current.validate()
        self._data["sites"][host] = {**current.__dict__, "_updated_at": time.time()}
        self._save()
        return self.site_theme(host)

    def has_site(self, host: str) -> bool:
        return (host or "").lower() in self._data["sites"]

    def clear_site_theme(self, host: str) -> dict:
        self._data["sites"].pop((host or "").lower(), None)
        self._save()
        return {"ok": True, "cleared": host}

    def list_sites(self) -> list[dict]:
        return [
            {"host": host, **Theme(**_fields(entry)).__dict__, "updated_at": entry.get("_updated_at", 0)}
            for host, entry in sorted(self._data["sites"].items())
        ]

    # -------------------------------------------------------------- buttons
    def buttons(self) -> dict:
        return dict(self._data.get("buttons", {}))

    def set_button(self, key: str, spec: dict) -> dict:
        if not key:
            raise ValueError("key is required")
        if not isinstance(spec, dict) or not spec.get("label"):
            raise ValueError("button spec needs a label")
        if spec.get("action") not in ("navigate", "open_tab", "run_tool", "scan", "clear_cookies", None):
            raise ValueError("button action must be one of navigate, open_tab, run_tool, scan, clear_cookies")
        self._data["buttons"][key] = {**spec, "updated_at": time.time()}
        self._save()
        return {"ok": True, "button": key, "buttons": self.buttons()}

    def remove_button(self, key: str) -> dict:
        self._data["buttons"].pop(key, None)
        self._save()
        return {"ok": True, "button": key, "buttons": self.buttons()}

    def reset(self) -> dict:
        self._data = {"global": {}, "sites": {}, "buttons": {}}
        self._save()
        return {"ok": True, "reset": True}


async def apply_theme(page: Any, css: str, *, scope: str = "html") -> None:
    """Inject (or replace) the stylesheet in a live page."""
    try:
        await page.evaluate(
            """([css, scope]) => {
                const id = '__netops_theme__';
                let node = document.getElementById(id);
                if (!node) {
                    node = document.createElement('style');
                    node.id = id;
                    (document.head || document.documentElement).appendChild(node);
                }
                node.textContent = css;
                document.documentElement.setAttribute('data-netops-theme', '1');
            }""",
            [css, scope],
        )
    except Exception:  # noqa: BLE001 - cross-origin or already closed
        pass
