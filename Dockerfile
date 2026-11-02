FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@0.162.1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN rm /usr/local/bin/codex && chmod +x /app/deploy/codex-container.ts && ln -s /app/deploy/codex-container.ts /usr/local/bin/codex
ENV TOKEN_HOST=0.0.0.0 TOKEN_PORT=8047 TOKEN_SPEED_FALLBACK=0
ENV TOKEN_RANGE_SCRIPT=/app/vendor/remaining-range/range.ts
EXPOSE 8047
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8047/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.ts"]
