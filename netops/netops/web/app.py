"""FastAPI application factory for the netops dashboard."""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from ..browser import BrowserService, ThemeStore
from ..config import NetopsConfig, load_config
from ..db import Database
from ..rotator_service import RotatorService
from ..security import LoginThrottle, validate_password
from . import api, auth, browser as browser_api

log = logging.getLogger("netops")

STATIC_DIR = Path(__file__).resolve().parent / "static"

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'"
    ),
}


def bootstrap_admin(config: NetopsConfig, db: Database) -> str | None:
    """Create the first administrator from netops.toml, if it asks for one."""
    if db.user_count():
        return None
    password = config.initial_password
    if not password:
        return None
    validate_password(password)
    username = config.initial_admin or "admin"
    db.create_user(username, password, role="admin", allow_admin=True)
    log.warning("bootstrapped administrator %r; remove initial_password from netops.toml", username)
    return username


def create_app(config_path: str | Path | None = None) -> FastAPI:
    config = load_config(config_path)
    db = Database(config.db_path)
    bootstrap_admin(config, db)
    db.purge_expired()

    rotator = RotatorService(config.rotator_config, database=db)
    autostart = (config.root / "var" / "autostart.flag").is_file()
    if autostart:
        result = rotator.start()
        if not result.get("ok"):
            log.error("rotator autostart failed: %s", result.get("error"))

    # the built-in privacy browser exits through the rotator when it is running
    proxy = None
    if rotator.running:
        endpoint = rotator.status().get("listeners", {}).get("http")
        if endpoint:
            proxy = {"server": f"http://{endpoint}"}
    browser = BrowserService(config.browser, config.root / "data" / "browser", proxy=proxy)
    themes = ThemeStore(config.root / "data" / "browser")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.started_at = time.time()
        yield
        rotator.stop()
        await browser.shutdown()

    app = FastAPI(
        title="netops",
        version="1.0.0",
        description="Rotating proxy control panel, host monitoring and network toolbox.",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.state.config = config
    app.state.db = db
    app.state.rotator = rotator
    app.state.browser = browser
    app.state.browser_themes = themes
    app.state.login_throttle = LoginThrottle()
    app.state.started_at = time.time()

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for header, value in SECURITY_HEADERS.items():
            response.headers.setdefault(header, value)
        response.headers.setdefault(
            "Cache-Control", "no-store" if request.url.path.startswith("/api") else "no-cache"
        )
        return response

    @app.exception_handler(ValueError)
    async def value_error_handler(request: Request, exc: ValueError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    app.include_router(auth.router)
    app.include_router(api.router)
    app.include_router(browser_api.router)

    @app.get("/api/health", tags=["meta"])
    def health() -> dict:
        return {
            "ok": True,
            "version": app.version,
            "uptime_seconds": round(time.time() - app.state.started_at, 1),
            "rotator_running": rotator.running,
            "browser_running": browser.running,
            "users": db.user_count(),
        }

    if STATIC_DIR.is_dir():
        @app.get("/", include_in_schema=False)
        def index() -> FileResponse:
            return FileResponse(STATIC_DIR / "index.html")

        @app.get("/favicon.ico", include_in_schema=False)
        def favicon() -> FileResponse:
            return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")

        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    return app


app = None


def get_app() -> FastAPI:
    global app
    if app is None:
        app = create_app()
    return app


async def serve() -> None:
    import uvicorn

    config = load_config()
    uvicorn.run(
        "netops.web.app:get_app",
        factory=True,
        host=config.host,
        port=config.port,
        log_level="info",
        access_log=True,
    )


if __name__ == "__main__":
    asyncio.run(serve())
