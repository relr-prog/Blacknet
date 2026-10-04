"""Cookie, storage and cache management for the built-in browser."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

__all__ = ["CookieManager", "StorageManager"]


def _redact(cookie: dict) -> dict:
    """Cookies are secrets: show enough to manage them, not enough to steal them."""
    value = cookie.get("value")
    return {
        "name": cookie.get("name"),
        "domain": cookie.get("domain"),
        "path": cookie.get("path", "/"),
        "expires": cookie.get("expires", -1),
        "session": cookie.get("expires", -1) in (-1, 0, None),
        "http_only": bool(cookie.get("httpOnly")),
        "secure": bool(cookie.get("secure")),
        "same_site": cookie.get("sameSite"),
        "size": len(str(value or "")),
        "value_preview": (str(value)[:4] + "…") if value else "",
    }


class CookieManager:
    def __init__(self, context: Any) -> None:
        self.context = context

    async def list(
        self, *, domain: str | None = None, include_expired: bool = False
    ) -> dict:
        now = time.time()
        rows = []
        for cookie in await self.context.cookies():
            entry = _redact(cookie)
            if domain and domain.lower() not in str(cookie.get("domain", "")).lower():
                continue
            if not include_expired and entry["expires"] not in (-1, 0) and entry["expires"] < now:
                entry["expired"] = True
            rows.append(entry)
        domains: dict[str, int] = {}
        for row in rows:
            key = str(row["domain"])
            domains[key] = domains.get(key, 0) + 1
        return {
            "count": len(rows),
            "cookies": rows,
            "domains": sorted(domains.items(), key=lambda kv: -kv[1])[:50],
            "session_cookies": sum(1 for row in rows if row["session"]),
            "third_party": sum(1 for row in rows if not str(row["domain"] or "").startswith(".")),
        }

    async def clear(self, *, domain: str | None = None) -> dict:
        if not domain:
            await self.context.clear_cookies()
            return {"ok": True, "cleared": "all", "count": len(await self.context.cookies())}
        cookies = [
            cookie
            for cookie in await self.context.cookies()
            if domain.lower() in str(cookie.get("domain", "")).lower()
        ]
        for cookie in cookies:
            try:
                await self.context.clear_cookies(
                    name=cookie["name"], domain=cookie["domain"], path=cookie.get("path", "/")
                )
            except TypeError:
                # older Playwright builds only support clear_cookies() with no args
                await self.context.clear_cookies()
                break
        return {"ok": True, "cleared": len(cookies), "domain": domain}

    async def export(self, path: str | Path, *, include_values: bool = False) -> dict:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        cookies = await self.context.cookies()
        if not include_values:
            cookies = [{**cookie, "value": ""} for cookie in cookies]
        payload = {"cookies": cookies, "exported_at": time.time(), "redacted": not include_values}
        target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return {"ok": True, "path": str(target), "count": len(cookies), "redacted": not include_values}

    async def stats(self) -> dict:
        rows = await self.list()
        return {
            "count": rows["count"],
            "domains": len(rows["domains"]),
            "session_cookies": rows["session_cookies"],
            "http_only": sum(1 for row in rows["cookies"] if row["http_only"]),
            "secure": sum(1 for row in rows["cookies"] if row["secure"]),
            "largest_domain": rows["domains"][0] if rows["domains"] else None,
        }


class StorageManager:
    """Cache, localStorage, service workers, downloads, permissions."""

    def __init__(self, context: Any, policy, data_dir: Path) -> None:
        self.context = context
        self.policy = policy
        self.data_dir = Path(data_dir)

    # ---------------------------------------------------------------- cache
    def cache_stats(self) -> dict:
        """Sum on-disk cache usage for the profile directory."""
        profile = Path(self.data_dir)
        total = 0
        files = 0
        biggest: list[tuple[int, str]] = []
        for path in Path(profile).rglob("*"):
            try:
                if not path.is_file():
                    continue
                size = path.stat().st_size
            except OSError:
                continue
            total += size
            files += 1
            if "cache" in str(path).lower():
                biggest.append((size, str(path.relative_to(profile))))
        biggest.sort(reverse=True)
        return {
            "profile": str(profile),
            "total_bytes": total,
            "files": files,
            "cache_bytes": sum(size for size, _ in biggest),
            "largest_cache_files": [
                {"path": path, "bytes": size} for size, path in biggest[:10]
            ],
            "cache_enabled": self.policy.cache_enabled,
        }

    async def clear_cache(self, *, domain: str | None = None) -> dict:
        before = self.cache_stats()
        removed = 0
        freed = 0
        for folder in ("Cache", "Code Cache", "GPUCache", "DawnCache", "Service Worker/CacheStorage",
                       "Default/Cache", "Default/Code Cache", "Default/Service Worker"):
            target = Path(before["profile"]) / folder
            if not target.is_dir():
                continue
            for path in target.rglob("*"):
                try:
                    if path.is_file():
                        freed += path.stat().st_size
                        path.unlink()
                        removed += 1
                except OSError:
                    continue
        if domain:
            await self._clear_origin_storage(domain)
        return {
            "ok": True,
            "files_removed": removed,
            "bytes_freed": freed,
            "total_before": before["total_bytes"],
        }

    async def storage_report(self) -> dict:
        """Per-tab storage footprint measured in the page itself."""
        pages = []
        for page in list(getattr(self.context, "pages", []) or []):
            if page.is_closed():
                continue
            try:
                info = await page.evaluate(
                    """() => {
                        const size = (store) => { try { return Object.keys(store || {}).length; }
                                               catch (e) { return 0; } };
                        return {
                            origin: location.origin,
                            localStorage: size(window.localStorage),
                            sessionStorage: size(window.sessionStorage),
                            cookies: document.cookie ? document.cookie.split(';').length : 0,
                        };
                    }"""
                )
            except Exception as exc:  # noqa: BLE001
                info = {"error": str(exc)[:120]}
            pages.append({"url": page.url, **info})
        return {"contexts": pages}

    async def _clear_origin_storage(self, domain: str) -> None:
        cdp = None
        for page in list(getattr(self.context, "pages", []) or []):
            if page.is_closed():
                continue
            try:
                cdp = await self.context.new_cdp_session(page)
                break
            except Exception:  # noqa: BLE001
                continue
        if cdp is None:
            return
        try:
            await cdp.send(
                "Storage.clearDataForOrigin",
                {
                    "origin": domain if "://" in domain else f"https://{domain}",
                    "storageTypes": "all",
                },
            )
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                await cdp.detach()
            except Exception:  # noqa: BLE001
                pass

    def permissions(self) -> list[str]:
        return list(self.policy.permissions)

    def grant(self, permission: str) -> dict:
        if permission not in self.policy.permissions:
            raise ValueError(f"permission {permission!r} is not in browser.permissions")
        return {"ok": True, "permissions": list(self.policy.permissions)}

    async def revoke_all(self) -> dict:
        """Drop every cookie and forget cached data for the whole profile."""
        await self.context.clear_cookies()
        await self.clear_cache()
        return {"ok": True, "detail": "cookies and caches cleared"}
