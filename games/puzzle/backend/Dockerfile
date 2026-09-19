# The puzzle API. Built from the repository root, so the one board list the game owns is baked in rather than
# duplicated: the client reads games/data/puzzle.json over HTTP, the server reads the same file from here.
#
#   docker build -f games/puzzle/backend/Dockerfile -t puzzle-api .
FROM node:22-alpine AS build
WORKDIR /build
COPY games/puzzle/backend/package.json games/puzzle/backend/package-lock.json* ./
# --include=dev, explicitly: typescript is a devDependency, and this stage would stop installing it the day
# anyone sets NODE_ENV=production above. The runtime stage below copies the pruned tree, not this one.
RUN npm ci --include=dev --no-audit --no-fund
COPY games/puzzle/backend/tsconfig.json ./
COPY games/puzzle/backend/src ./src
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
    addgroup -g 10001 puzzle && adduser -D -u 10001 -G puzzle puzzle
WORKDIR /srv/puzzle
ENV NODE_ENV=production \
    PUZZLE_BOARDS_FILE=/srv/puzzle/data/puzzle.json \
    PUZZLE_MIGRATIONS_DIR=/srv/puzzle/migrations
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY games/puzzle/migrations ./migrations
COPY games/data/puzzle.json ./data/puzzle.json
COPY games/puzzle/deploy/backup.sh games/puzzle/deploy/restore.sh ./bin/
RUN chmod +x ./bin/*.sh && chown -R puzzle:puzzle /srv/puzzle
USER puzzle
EXPOSE 8760
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8760)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
