# syntax=docker/dockerfile:1
# VodaForge: builds the admin app (`npm run build`), then runs the production server.
#   docker compose up -d --build        (see compose.yaml and README.md)

ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# ---- build the admin app (needs dev dependencies) ----
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime dependencies only ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4400 \
    REEF_DATA_DIR=/data \
    REEF_BACKUP_DIR=/backups
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY server ./server
COPY shared ./shared
COPY static ./static
COPY scripts ./scripts
COPY --from=build /app/dist ./dist
# Empty named volumes inherit this ownership, so the app can write without root.
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4400)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Same as `npm start` (NODE_ENV=production is set above), minus the npm wrapper, which
# doesn't pass docker stop's SIGTERM on to Node. VodaForge then closes the database cleanly.
CMD ["node", "--import", "tsx", "server/index.ts"]
