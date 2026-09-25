# Production gateway image; supersedes the former development-agent Dockerfile.
# Base approved in docs/DEPENDENCY_LOCK.md; do not override it with a build arg.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
# Enumerated production inputs also exclude scaffold independently of ignore rules.
COPY src/main.ts src/server.ts ./src/
COPY src/autodiscover/ ./src/autodiscover/
COPY src/cache/ ./src/cache/
COPY src/config/ ./src/config/
COPY src/core/ ./src/core/
COPY src/directory/ ./src/directory/
COPY src/ews/ ./src/ews/
COPY src/freebusy/ ./src/freebusy/
COPY src/http/ ./src/http/
COPY src/observability/ ./src/observability/
COPY src/providers/ ./src/providers/
COPY src/resilience/ ./src/resilience/
COPY src/runtime/ ./src/runtime/
COPY src/security/ ./src/security/
COPY src/time/ ./src/time/
COPY src/xml/ ./src/xml/
RUN npm run build -- --sourceMap false --declaration false

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# No credentials, administrator configuration, fixtures or lab entrypoint.
USER 1000:1000
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]
