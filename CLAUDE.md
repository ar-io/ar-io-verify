# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ar.io Verify — a verification sidecar for ar.io gateways. Independently proves existence, authenticity, and authorship of data stored on the Arweave blockweave. Gateway operators sign attestations with their Arweave wallet.

Three verification levels: (1) existence on-chain, (2) SHA-256 data integrity, (3) cryptographic signature verification via deep hash reconstruction. Level 3 is the full proof — it mathematically confirms the stated owner signed this exact data.

## Commands

```bash
pnpm install                 # Install all dependencies
pnpm run build              # Build server + web
pnpm run dev                # Server only (tsx --watch) — does NOT start the web app
pnpm --filter verify-web run dev   # Web app only (Vite, separate terminal)
pnpm run test               # Run all server tests (vitest)
pnpm run format             # Format code (run before commit)

# Run a single test file or filter by name
pnpm --filter @ar-io/verify-server run test -- tests/utils/crypto.test.ts
pnpm --filter @ar-io/verify-server run test -- -t "deep hash"

# Deploy alongside an ar.io gateway
cd deploy && bash start.sh
```

Tests live in `packages/server/tests/` (mirrors `src/` layout), not co-located with source files.

## Architecture

```
packages/
  server/    Express server: verification pipeline, PDF certificates, SQLite cache, attestation signing
  web/       React 19 + Vite frontend: verification UI (Tailwind CSS, served at /verify/)
deploy/      Standalone Docker Compose deployment
```

**Verification pipeline** (`packages/server/src/pipeline/orchestrator.ts`):

1. HEAD /raw/ + GraphQL — in parallel (~50ms)
2. Determine L1 tx vs ANS-104 data item
3. Download raw data + fetch binary header (range request on root bundle)
4. Signature verification: RSA-PSS (type 1), ED25519 (type 2), Ethereum ECDSA (type 3)
5. Operator attestation — sign result with gateway wallet

**Key files:**

- `server/src/utils/crypto.ts` — deep hash, RSA-PSS, ED25519, ECDSA, Avro tag serialization
- `server/src/utils/ans104-parser.ts` — ANS-104 binary header parser
- `server/src/utils/signing.ts` — JWK loader, attestation builder, RSA-PSS signer (standard single-hash: `createSign('sha256').update(canonical)`)
- `server/src/gateway/client.ts` — gateway API client (HEAD, GET, GraphQL, range requests)
- `server/src/openapi.json` — OpenAPI 3.0 spec (served at /api-docs/)

## Critical Notes

1. Run `pnpm run format` before every commit
2. The server's unique value is **PDF signing with operator wallet** — everything else could run client-side
3. `/tx/` via Envoy always 404s for data items — use GraphQL + /raw/ headers instead
4. Tags from HTTP headers are alphabetical (wrong order) — use GraphQL or binary header for sig verification
5. Ethereum ECDSA (type 3) verification is implemented but may not verify all signer implementations
6. Binary header fetch has a 3s timeout (10s for non-RSA) — falls back to GraphQL tags if root bundle is slow
7. `WALLET_FILE` in deploy `.env` is the host path to the JWK wallet. Compose mounts it to `/app/wallet.json` and sets `SIGNING_KEY_PATH` inside the container. Server works without it, just no attestation.
8. When running in Docker, `GATEWAY_URL` must NOT be `localhost`/`127.0.0.1` — config validation in `server/src/config.ts` rejects it on startup. Use the gateway service hostname (e.g. `http://core:4000`) on the shared `ar-io-network`.
9. Env config is parsed with zod in `server/src/config.ts` — add new env vars there, not ad-hoc `process.env` reads.
10. Frontend image previews read `publicGatewayUrl` from `GET /api/config`. Resolution order: `PUBLIC_GATEWAY_URL` → `https://${GATEWAY_HOST}` → `https://turbo-gateway.com`. The sidecar no longer proxies `/raw/` — image loads go directly to the gateway.

## API Endpoints

Interactive docs at `/api-docs/` (Swagger UI).

- `POST /api/v1/verify` — verify a transaction
- `GET /api/v1/verify/:id` — get cached result
- `GET /api/v1/verify/tx/:txId` — verification history
- `GET /api/v1/verify/:id/pdf` — PDF certificate
- `GET /api/v1/verify/:id/attestation` — attestation for programmatic verification
- `GET /api/config` — runtime frontend config (public gateway URL for image previews)
- `GET /health` — health check

## Console Integration

This verify backend is consumed by the ar.io Console (`ar-io/ar-io-console`) at `/verify`. The console's `verifyApiUrl` in the store config points to this server.
