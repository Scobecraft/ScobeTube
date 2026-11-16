FROM denoland/deno:bin AS deno

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH="/opt/venv/bin:$PATH" \
    DOWNLOAD_DIR=/downloads \
    STATE_DIR=/data \
    XDG_CACHE_HOME=/data/.cache \
    HOME=/data \
    PORT=8081

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Deno: JavaScript-Laufzeit, die yt-dlp für YouTube benötigt
COPY --from=deno /deno /usr/local/bin/deno

COPY requirements.txt /tmp/requirements.txt
RUN python -m venv /opt/venv \
 && pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY app ./app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /downloads /data

EXPOSE 8081
VOLUME ["/downloads", "/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s \
  CMD python -c "import os,urllib.request;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8081\")}/healthz',timeout=4)" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "app"]
