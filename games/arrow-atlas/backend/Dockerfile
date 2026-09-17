# arrow-atlas-api. Built from the repository root, so the one board list the game owns is baked in rather than
# duplicated: the client reads games/data/arrow-atlas.json over HTTP, the server reads the same file from here.
#
#   docker build -f games/arrow-atlas/backend/Dockerfile -t arrow-atlas-api .
FROM node:22-alpine AS build
WORKDIR /build
COPY games/arrow-atlas/backend/package.json games/arrow-atlas/backend/package-lock.json* ./
# --include=dev, explicitly: typescript is a devDependency, and this stage would stop installing it the day
# anyone sets NODE_ENV=production above. The runtime stage below copies the pruned tree, not this one.
RUN npm ci --include=dev --no-audit --no-fund
COPY games/arrow-atlas/backend/tsconfig.json ./
COPY games/arrow-atlas/backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS run
# dumb-init gives PID 1 proper signal handling, so a deploy drains connections instead of severing them.
# postgresql-client is what the backup and restore scripts shell out to.
# The client package is named after the server version it ships, which moves with Alpine, so take the one that
# matches our server and fall back to whatever the distribution calls current. A newer pg_dump reads an older
# server quite happily; it is the other way round that fails.
RUN apk add --no-cache dumb-init && \
    (apk add --no-cache postgresql16-client || apk add --no-cache postgresql-client) && \
    pg_dump --version && \
    addgroup -g 10001 arrowatlas && adduser -D -u 10001 -G arrowatlas arrowatlas
WORKDIR /srv/arrow-atlas
ENV NODE_ENV=production \
    ARROW_ATLAS_BOARDS_FILE=/srv/arrow-atlas/data/arrow-atlas.json \
    ARROW_ATLAS_MIGRATIONS_DIR=/srv/arrow-atlas/migrations
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY games/arrow-atlas/migrations ./migrations
COPY games/data/arrow-atlas.json ./data/arrow-atlas.json
COPY games/arrow-atlas/deploy/backup.sh games/arrow-atlas/deploy/restore.sh ./bin/
RUN chmod +x ./bin/*.sh && chown -R arrowatlas:arrowatlas /srv/arrow-atlas
USER arrowatlas
EXPOSE 8760
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8760)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
