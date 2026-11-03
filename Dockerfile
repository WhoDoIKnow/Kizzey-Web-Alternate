# Kizzey Web — Node.js server, no browser in the image.
#
# Browser sign-in is not available here; use the Discord sign-in sheet (password
# or MFA) or add an account token in the web UI. No Chromium is installed.
FROM node:22-slim

ENV NODE_ENV=production \
    KIZZEY_HOST=0.0.0.0 \
    KIZZEY_PORT=8420

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund

COPY server.js script_pull.js ./
COPY lib ./lib
COPY static ./static

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.KIZZEY_PORT||'8420')+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
