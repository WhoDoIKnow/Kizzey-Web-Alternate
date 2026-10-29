# Kizzey Web — standard library only, no browser in the image.
#
# Browser sign-in runs against KIZZEY_BROWSER_CDP when it is set, so this
# container never needs Chromium. Without an endpoint, use the password or
# token sign-in in the web UI.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    KIZZEY_HOST=0.0.0.0 \
    KIZZEY_PORT=8420

WORKDIR /app
COPY server.py script_pull.py ./
COPY static ./static

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('KIZZEY_PORT','8420')+'/api/health', timeout=3).read()"

CMD ["python3", "server.py"]
