# Kizzey voice service — Discord voice join, music playback and Opus recording.
#
# This image is separate from the Kizzey web image because it needs ffmpeg and
# the Discord voice stack.  Kizzey itself stays standard-library only and talks
# to this service over HTTP.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VOICE_HOST=0.0.0.0 \
    VOICE_PORT=8421 \
    VOICE_RECORDINGS_DIR=/data/voice_recordings

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates git libopus0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY voice_service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY voice_service/voice_service.py ./

RUN mkdir -p /data/voice_recordings
VOLUME ["/data/voice_recordings"]
EXPOSE 8421

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('VOICE_PORT','8421')+'/health', timeout=3).read()"

CMD ["python3", "voice_service.py"]
