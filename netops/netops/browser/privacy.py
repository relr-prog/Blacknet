"""Privacy hardening: launch flags, context options, tracker blocking, prefs.

Everything here is opt-out configurable through ``[browser]`` in netops.toml so
the panel can be as locked down (or as relaxed) as the operator wants.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..config import BrowserPolicy

__all__ = [
    "build_launch_args",
    "build_context_options",
    "firefox_prefs",
    "TRACKER_PATTERNS",
    "match_blocker",
    "summary",
]

# Compact, dependency-free tracker/ad-tech patterns. Matched against request
# URLs; hosts are blocked, paths are matched as substrings.
TRACKER_PATTERNS: tuple[str, ...] = (
    "doubleclick.net",
    "googlesyndication.com/pagead",
    "google-analytics.com",
    "googleadservices.com",
    "googletagmanager.com/gtm.js",
    "analytics.tiktok.com",
    "connect.facebook.net",
    "facebook.com/tr",
    "bat.bing.com",
    "analytics.yahoo.com",
    "scorecardresearch.com",
    "quantserve.com",
    "hotjar.com",
    "fullstory.com",
    "mixpanel.com",
    "segment.io",
    "segment.com/api",
    "amplitude.com",
    "branch.io",
    "crazyegg.com",
    "optimizely.com",
    "sentry.io/api",
    "newrelic.com",
    "nr-data.net",
    "clarity.ms",
    "yandex.ru/metrika",
    "mc.yandex.ru",
    "adservice.google",
    "ads-twitter.com",
    "adnxs.com",
    "rubiconproject.com",
    "pubmatic.com",
    "openx.net",
    "criteo.com",
    "taboola.com",
    "outbrain.com",
    "snapchat.com/tr",
    "tiktok.com/api",
    "hotjar.io",
    "fingerprintjs.com",
    "bugsnag.com",
    "intercom.io",
    "driftt.com",
    "zendesk.com/embed",
    "onetrust.com",
    "cookiebot.com",
    "cookielaw.org",
    "usercentrics.eu",
    "cloudflareinsights.com",
    "speedcurve.com",
    "loggly.com",
    "datadoghq.com",
    "statuspage.io",
    "mapbox.com",
    "googleapis.com/recaptcha",
    "hcaptcha.com",
)


def match_blocker(url: str, extra: tuple[str, ...] = ()) -> str | None:
    """Return the pattern that blocked this URL, or None when it may load."""
    lowered = (url or "").lower()
    for pattern in tuple(extra) + TRACKER_PATTERNS:
        if pattern in lowered:
            return pattern
    return None


def build_launch_args(policy: BrowserPolicy) -> list[str]:
    """Chromium flags that strip telemetry and shrink the fingerprint."""
    disabled = [
        "Translate",
        "OptimizationHints",
        "MediaRouter",
        "InterestFeedContentSuggestions",
        "CalculateNativeWinOcclusion",
        "AutofillServerCommunication",
        "PrivacySandboxSettings4",
    ]
    args: list[str] = [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-service-autorun",
        "--password-store=basic",
        "--use-mock-keychain",
        "--enable-features=NetworkService,NetworkServiceInProcess",
    ]
    if policy.resist_fingerprinting:
        disabled += ["IsolateOrigins", "site-per-process"]
        args += [
            "--disable-blink-features=AutomationControlled",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--disable-webrtc",
            "--disable-extensions",
            "--disable-speech-api",
        ]
    # a single --disable-features flag: repeated ones override each other
    args.append("--disable-features=" + ",".join(disabled))
    if policy.https_only:
        args.append("--https-only-mode-upgrades")
    if policy.no_sandbox:
        args.append("--no-sandbox")
    if policy.block_notifications:
        args.append("--disable-notifications")
    if policy.proxy_dns:
        # SOCKS5 remote DNS: never leak the hostname to the local resolver
        args.append("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost")
    if policy.disable_pdf_viewer:
        args.append("--disable-pdf-viewer")
    args += list(policy.extra_args)
    return args


def build_context_options(policy: BrowserPolicy, *, proxy: dict | None = None) -> dict[str, Any]:
    """Context settings shared by both engines."""
    options: dict[str, Any] = {
        "viewport": {"width": policy.viewport_width, "height": policy.viewport_height},
        "locale": policy.locale,
        "timezone_id": policy.timezone,
        "color_scheme": "dark" if policy.prefers_dark else "light",
        "device_scale_factor": policy.device_scale_factor,
        "has_touch": policy.has_touch,
        "java_script_enabled": not policy.disable_javascript,
        "bypass_csp": False,
        "service_workers": "block" if policy.block_service_workers else "allow",
        "ignore_https_errors": policy.ignore_https_errors,
        "extra_http_headers": {
            "DNT": "1",
            "Sec-GPC": "1",
            "Accept-Language": policy.locale,
        },
    }
    if policy.engine == "chromium":
        # is_mobile is a chromium-only option; Playwright rejects it elsewhere
        options["is_mobile"] = False
    if policy.user_agent:
        options["user_agent"] = policy.user_agent
    if proxy and proxy.get("server"):
        route: dict[str, Any] = {"server": proxy["server"]}
        if proxy.get("username"):
            route["username"] = proxy["username"]
        if proxy.get("password"):
            route["password"] = proxy["password"]
        if proxy.get("bypass"):
            route["bypass"] = proxy["bypass"]
        options["proxy"] = route
    if policy.storage_state and Path(policy.storage_state).is_file():
        options["storage_state"] = policy.storage_state
    if policy.permissions:
        options["permissions"] = list(policy.permissions)
    if policy.downloads_path:
        options["accept_downloads"] = True
    if policy.engine == "firefox":
        options["firefox_user_prefs"] = firefox_prefs(policy)
    return options


def firefox_prefs(policy: BrowserPolicy) -> dict[str, Any]:
    """resistFingerprinting-style preferences for the Firefox engine."""
    prefs: dict[str, Any] = {
        "privacy.resistFingerprinting": policy.resist_fingerprinting,
        "privacy.reduceTimerPrecision": policy.resist_fingerprinting,
        "privacy.trackingprotection.enabled": True,
        "privacy.trackingprotection.pbmode.enabled": True,
        "privacy.trackingprotection.socialtracking.block_cookies": True,
        "privacy.trackingprotection.cryptomining.enabled": False,
        "privacy.trackingprotection.fingerprinting.enabled": True,
        "privacy.donottrackheader.enabled": True,
        "privacy.globalprivacycontrol.enabled": True,
        "privacy.sanitize.sanitizeOnShutdown": True,
        "network.cookie.cookieBehavior": policy.block_third_party_cookies and 5 or 2,
        "network.cookie.lifetimePolicy": 0,
        "network.http.referer.XOriginPolicy": 0,
        "network.dns.disablePrefetch": True,
        "network.dns.disablePrefetchFromHTTPS": True,
        "network.prefetch-next": False,
        "browser.cache.disk.enable": policy.cache_enabled,
        "browser.cache.memory.enable": policy.cache_enabled,
        "dom.webaudio.enabled": False,
        "media.peerconnection.enabled": not policy.disable_webrtc,
        "media.peerconnection.ice.default_address_only": True,
        "browser.region.network.url": "",
        "browser.safebrowsing.downloads.remote.enabled": False,
        "browser.safebrowsing.malware.enabled": False,
        "browser.safebrowsing.phishing.enabled": False,
        "app.update.auto": False,
        "app.update.enabled": False,
        "extensions.webextensions.restrictedDomains": "",
        "datareporting.healthreport.uploadEnabled": False,
        "toolkit.telemetry.enabled": False,
        "toolkit.telemetry.unified": False,
        "services.settings.server": "",
    }
    if policy.block_notifications:
        prefs["dom.webnotifications.enabled"] = False
        prefs["dom.push.enabled"] = False
    if policy.locale:
        prefs["intl.accept_languages"] = policy.locale
    return prefs


def summary(policy: BrowserPolicy) -> dict[str, Any]:
    """Human-readable description of what the privacy posture actually is."""
    return {
        "engine": policy.engine,
        "headless": policy.headless,
        "privacy": {
            "block_third_party_cookies": policy.block_third_party_cookies,
            "resist_fingerprinting": policy.resist_fingerprinting,
            "https_only": policy.https_only,
            "disable_webrtc": policy.disable_webrtc,
            "disable_javascript": policy.disable_javascript,
            "block_service_workers": policy.block_service_workers,
            "block_notifications": policy.block_notifications,
            "dnt": True,
            "sec_gpc": True,
            "cache_enabled": policy.cache_enabled,
            "clear_on_close": policy.clear_on_close,
        },
        "network": {
            "locale": policy.locale,
            "timezone": policy.timezone,
            "proxy_dns": policy.proxy_dns,
            "ignored_https_errors": policy.ignore_https_errors,
        },
        "blocklist_size": len(TRACKER_PATTERNS),
    }
