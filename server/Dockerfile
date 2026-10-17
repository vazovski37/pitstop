# Build context is the repository root:
#   docker build -f server/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) .

FROM node:22-alpine AS build
WORKDIR /app

# Install with every workspace manifest present, so the lockfile resolves.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
COPY daemon/package.json daemon/
COPY mcp/package.json mcp/
COPY packages/cli/package.json packages/cli/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY packages/protocol packages/protocol
COPY server server
COPY web web
# The client, bundled from daemon/ and mcp/ and packed into web/dist/pitstop-cli.tgz, which the
# server serves at /pitstop-cli.tgz: `npm install -g https://<server>/pitstop-cli.tgz`.
COPY daemon daemon
COPY mcp mcp
COPY packages/cli packages/cli
RUN npm run build -w @pitstop/protocol -w @pitstop/server -w @pitstop/web \
 && npm run pack:cli \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations
# The live view, served by the server at / (web/CLAUDE.md), and the client's tarball beside it.
COPY --from=build /app/web/dist ./web/dist

USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
