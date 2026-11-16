import os

import uvicorn

from . import config

if __name__ == "__main__":
    uvicorn.run(
        "app.main:application",
        host=config.HOST,
        port=config.PORT,
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
