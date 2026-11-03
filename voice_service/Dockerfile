# Kizzey voice service — Discord voice join, music playback and Opus recording.
#
# This image is separate from the Kizzey web image because it needs ffmpeg and
# the Discord voice stack. @discordjs/voice 0.19 negotiates DAVE end-to-end
# encryption; discord.js-selfbot-v13 supplies the account-token gateway.
FROM node:22-slim

ENV NODE_ENV=production \
    VOICE_HOST=0.0.0.0 \
    VOICE_PORT=8421 \
    VOICE_RECORDINGS_DIR=/data/voice_recordings

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg yt-dlp ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund

COPY voice_service/index.js ./voice_service/index.js

RUN mkdir -p /data/voice_recordings
VOLUME ["/data/voice_recordings"]
EXPOSE 8421

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.VOICE_PORT||'8421')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "voice_service/index.js"]
