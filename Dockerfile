# =============================================================================
# ar.io Verify — Docker image
# =============================================================================
# Builds both the server (Express + SQLite) and web frontend (React + Vite).
# Native modules (better-sqlite3) compile via pnpm lifecycle scripts.
# =============================================================================

FROM node:20-bookworm-slim

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Install build tools for native modules (better-sqlite3 node-gyp) and curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package configs for install
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Install all workspace deps (pnpm runs lifecycle scripts by default)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/server/ packages/server/
COPY packages/web/ packages/web/

# Build the backend
RUN pnpm --filter @ar-io/verify-server run build

# Copy assets to dist directory (tsup doesn't bundle binary/JSON assets)
RUN cp -r packages/server/src/attestation/fonts packages/server/dist/fonts 2>/dev/null || true
RUN cp packages/server/src/openapi.json packages/server/dist/openapi.json 2>/dev/null || true

# Build the frontend
RUN pnpm --filter verify-web run build

# Create directory for data
RUN mkdir -p /app/data

# Set environment
ENV NODE_ENV=production
ENV PORT=4001
ENV SQLITE_PATH=/app/data/verify.db

EXPOSE 4001

WORKDIR /app/packages/server

CMD ["node", "dist/index.js"]
