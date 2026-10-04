"""Run the dashboard with ``python -m netops``."""

from __future__ import annotations

import asyncio
import os

from .config import load_config


def main() -> None:
    import uvicorn

    config = load_config(os.environ.get("NETOPS_CONFIG"))
    print(
        f"netops dashboard -> http://{config.host}:{config.port}  "
        f"(config: {os.environ.get('NETOPS_CONFIG', 'netops.toml')}, "
        f"rotator: {config.rotator_config})"
    )
    uvicorn.run(
        "netops.web.app:create_app",
        factory=True,
        host=config.host,
        port=config.port,
        log_level="info",
    )


if __name__ == "__main__":
    asyncio.run(main())
