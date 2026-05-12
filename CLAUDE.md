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
# After pulling code changes, force an image rebuild:
cd deploy && bash start.sh --rebuild
```

Filter targets: server = `@ar-io/verify-server`, web = `verify-web`.

Tests live in `packages/server/tests/` (mirrors `src/` layout), not co-located with source files.

## Architecture

```
packages/
  server/    Express server: verification pipeline, PDF certificates, SQLite cache, attestation signing, batch jobs
  web/       React 19 + Vite frontend: verification UI (Tailwind CSS, served at /verify/)
deploy/      Standalone Docker Compose deployment
```

**Verification pipeline** (`packages/server/src/pipeline/orchestrator.ts`):

1. HEAD /raw/ + GraphQL — in parallel (~50ms)
2. Determine L1 tx vs ANS-104 data item
3. Download raw data + fetch binary header (range request on root bundle)
4. Signature verification: RSA-PSS (type 1), ED25519 (type 2), Ethereum ECDSA (type 3)
5. Operator attestation — sign result with gateway wallet

**Batch verification jobs** (`packages/server/src/pipeline/job-worker.ts` + `routes/jobs.ts`):

- `POST /api/v1/jobs` accepts `{ txIds: string[] }` (max 50,000 per job, request body capped at 16 MB), returns 202 + `{ jobId }`. Honors `Idempotency-Key` per tenant (printable ASCII, ≤128 chars).
- Worker pool (in-process) drains jobs concurrently. Per-job fan-out is bounded by `JOB_WORKER_CONCURRENCY` (default 8); the actual ceiling on outbound fetches is the **global gateway budget** semaphore in `gateway/budget.ts` (`GATEWAY_MAX_INFLIGHT`, default 32). Both batch jobs and ad-hoc `/verify` share that budget.
- Each tx hits the verification cache first (`storage/cache.ts`) and only runs the pipeline on cache miss. The cache stores **only permanent outcomes** (verified / tampered) — transient unavailables are NOT cached, so re-runs retry rather than replaying stale "unavailable" answers.
- Worker writes per-tx outcomes (`verified` / `tampered` / `unavailable`) with granular `failure_reason` (e.g. `signature_mismatch`, `tx_id_mismatch`, `gateway_timeout`, `gateway_404`, `data_too_large`, `binary_header_unavailable`).
- On run completion, builds + signs a **VerificationBundleV1** — canonical-JSON, operator-signed, schema-versioned, machine-verifiable offline. PDF view of the same bundle is post-MVP (returns 406).
- Emits pull-based events to `job_events` table (`run.completed | run.failed | run.cancelled`). Consumers poll `GET /api/v1/jobs/events?since=…`. No outbound webhooks.
- Stall detector (`startStallDetector`) fails any run that hasn't recorded progress within `JOB_STALL_MS` (default 5 min).
- Restart resilience: `sweepStaleRunning` resets `running` → `pending` on boot but **leaves `job_runs` rows in `running` status** so `getCompletedTxIds(run.id)` correctly preserves prior progress. `resumePending` re-enqueues. Already-completed txIds are skipped on resume (real partial-run resume — without preserving the run row this is dead code).
- All terminal-state transitions on `job_runs` (`completeRun`, `failRun`, `cancelRun`) and counter mutations (`bumpRunCounters`, `recordResult`) are **status-conditional** (`WHERE status='running'`). Late-arriving worker writes after cancellation/stall are dropped rather than poisoning a terminal run.
- `pruneOldJobs` runs on a 6-hour interval; jobs older than `JOBS_RETENTION_MS` (30 days) are deleted and child rows cascade. `job_events` are pruned by age (no FK).

**Tenancy model:** Verify is multi-tenant by an opaque `X-Tenant-Id` header injected by whatever sits in front (an API gateway, reverse proxy, etc). Verify itself does **not** authenticate, rate-limit, quota, or interpret the value — it is purely a partition key. The middleware does enforce a length+charset envelope (`^[A-Za-z0-9_.:-]{1,128}$`) so the value can't bloat the unique idempotency index. In `NODE_ENV != 'production'`, missing tenant header falls back to a synthetic dev tenant so the sidecar can be exercised standalone. See `middleware/tenant.ts`.

**Single-process only.** The worker pool keeps in-memory state (`inflightJobs` set, semaphore permits) and SQLite is local. Don't run two replicas against the same DB — there's no row-level lock between processes that picks `pending` jobs. Horizontal scaling is post-MVP and tracked via the federation roadmap item.

**Key files:**

- `server/src/utils/crypto.ts` — deep hash, RSA-PSS, ED25519, ECDSA, Avro tag serialization
- `server/src/utils/ans104-parser.ts` — ANS-104 binary header parser
- `server/src/utils/signing.ts` — JWK loader, attestation + bundle signer, deep canonicalization
- `server/src/gateway/client.ts` — gateway API client (HEAD, GET, GraphQL, range requests; all wrapped in the global budget)
- `server/src/gateway/budget.ts` — process-wide semaphore over outbound gateway fetches
- `server/src/storage/db.ts` — shared SQLite connection (WAL mode)
- `server/src/storage/jobs.ts` — jobs / runs / results / events / bundles repository
- `server/src/pipeline/job-worker.ts` — worker pool, stall detector, partial-run resume, cancellation
- `server/src/pipeline/bundle.ts` — VerificationBundleV1 builder + signer
- `server/src/pipeline/outcome.ts` — VerificationResult → (outcome, failureReason) mapping
- `server/src/middleware/tenant.ts` — `X-Tenant-Id` extraction
- `server/src/openapi.json` — OpenAPI 3.0 spec (served at /api-docs/)

## Critical Notes

1. Run `pnpm run format` before every commit. CI (`.github/workflows/ci.yml`) runs `format:check`, `typecheck`, `build`, `vitest`, and a Docker image build on every push to `main` and every PR — formatting failures will block merges.
2. The server's unique value: **multi-tenant job state, operator-signed verification bundles, the cache, and pull-based events**. The single-tx verification math could in principle run client-side, but the batch jobs surface fundamentally cannot — job lifecycle, tenant isolation, the cache, and operator-wallet signing are all server-only.
3. `/tx/` via Envoy always 404s for data items — use GraphQL + /raw/ headers instead
4. Tags from HTTP headers are alphabetical (wrong order) — use GraphQL or binary header for sig verification
5. Ethereum ECDSA (type 3) verification is implemented but may not verify all signer implementations
6. Binary header fetch has a 3s timeout (10s for non-RSA) — falls back to GraphQL tags if root bundle is slow
7. `WALLET_FILE` in deploy `.env` is the host path to the JWK wallet. Compose mounts it to `/app/wallet.json` and sets `SIGNING_KEY_PATH` inside the container. Server works without it, just no attestation.
8. When running in Docker, `GATEWAY_URL` must NOT be `localhost`/`127.0.0.1` — config validation in `server/src/config.ts` rejects it on startup. Use the gateway service hostname (e.g. `http://core:4000`) on the shared `ar-io-network`.
9. Env config is parsed with zod in `server/src/config.ts` — add new env vars there, not ad-hoc `process.env` reads.
10. Frontend image previews read `publicGatewayUrl` from `GET /api/config`. Resolution order: `PUBLIC_GATEWAY_URL` → `https://${GATEWAY_HOST}` → `https://turbo-gateway.com`. The sidecar no longer proxies `/raw/` — image loads go directly to the gateway.
11. The pipeline verifies `SHA-256(signature) == requested txId` (see `pipeline/orchestrator.ts`). This is a deliberate substitution check — a malicious gateway can return valid-looking data for the wrong txId, and this catches it. Do not remove as "redundant."
12. The verification cache (`storage/cache.ts`) only stores **permanent outcomes** (verified / tampered). Transient `unavailable` results are intentionally NOT cached so future re-verifications retry. Don't "fix" `saveResult` to cache everything — the change-detection signal depends on this filter.
13. `signing.ts:canonicalize` is **deep recursive**. Sorts keys at every level. Arrays preserve order (array order is semantic). Both per-tx attestations and run bundles depend on this — verifier compatibility hinges on byte-identical canonicalization.
14. The bundle artifact (`pipeline/bundle.ts`) is the primary output of a job, NOT a PDF. PDF view is post-MVP and returns 406 today. Verifiers re-canonicalize the bundle minus `signature` + `payloadHash`, recompute SHA-256 to match `payloadHash`, then verify RSA-PSS-SHA256 against `operatorPublicKey`.
15. Verify never knows about auth, tier, billing, or rate limits — those are upstream concerns. The only thing verify reads from request headers (besides `Idempotency-Key`) is `X-Tenant-Id`, which it treats as opaque.
16. Job request body limit is **16 MB** (`express.json({ limit: '16mb' })`) and the per-job txId cap is **50,000**. Both must move together — bumping zod's `max(50_000)` without lifting the body limit produces silent 413 errors before zod validation runs. Keep them aligned.
17. Status-conditional UPDATEs are load-bearing for cancellation correctness. Don't simplify `WHERE id = ? AND status = 'running'` to `WHERE id = ?` in `bumpRunCounters` / `recordResult` / `completeRun` / `failRun` / `cancelRun` — late-arriving worker writes will resurrect cancelled runs.
18. Graceful shutdown drains the worker pool. `SIGTERM`/`SIGINT` triggers: (1) HTTP server stops accepting new connections, (2) timers stop, (3) `drainInflight(SHUTDOWN_DRAIN_MS)` waits for in-flight verifies — bounded by `SHUTDOWN_DRAIN_MS` (default 30s), (4) DB closes, exit. Anything still running after the drain cap is recovered by `sweepStaleRunning` on next boot. **Don't replace with `process.exit(0)` directly** — rolling deploys depend on this.
19. The Prometheus registry (`utils/metrics.ts`) intentionally has **no per-tenant labels**. Tenant id has unbounded cardinality (one customer's misuse can blow up Prom's time-series count). Per-tenant accounting belongs at api-guard, which knows the tenant→customer mapping; verify exposes aggregate health only.

## API Endpoints

Interactive docs at `/api-docs/` (Swagger UI).

Single-tx (no auth — direct):

- `POST /api/v1/verify` — verify a transaction
- `GET /api/v1/verify/:id` — get cached result
- `GET /api/v1/verify/tx/:txId` — verification history
- `GET /api/v1/verify/:id/pdf` — PDF certificate
- `GET /api/v1/verify/:id/attestation` — attestation for programmatic verification

Batch jobs (require `X-Tenant-Id` header):

- `POST /api/v1/jobs` — submit txIds for batch verification (honors `Idempotency-Key`)
- `GET /api/v1/jobs/:id` — status + counters + ETA
- `GET /api/v1/jobs/:id/results` — paginated per-tx outcomes with granular failure reasons
- `GET /api/v1/jobs/:id/report` — signed verification bundle (canonical JSON)
- `GET /api/v1/jobs/events?since=…` — pull-based event stream
- `DELETE /api/v1/jobs/:id` — soft-cancel

Ops (no tenant header — internal probes / scrape):

- `GET /health` — liveness probe (process is up + gateway-reachable boolean)
- `GET /ready` — readiness probe (returns 503 with per-check breakdown if DB or gateway are down)
- `GET /metrics` — Prometheus scrape endpoint. Default node metrics under `verify_` prefix plus domain counters/gauges/histograms (`verify_jobs_created_total`, `verify_runs_total{status}`, `verify_tx_outcomes_total{outcome,cache_hit}`, `verify_gateway_requests_total`, `verify_gateway_queue_depth`, `verify_signing_enabled`, `verify_inflight_jobs`, `verify_run_duration_seconds`, `verify_http_requests_total{route,status_class}`, etc). **Cardinality discipline: no `tenant_id` labels** — operators get aggregates; per-tenant accounting belongs upstream.

Misc:

- `GET /api/config` — runtime frontend config (public gateway URL for image previews)

## Console Integration

This verify backend is consumed by the ar.io Console (`ar-io/ar-io-console`) at `/verify`. The console's `verifyApiUrl` in the store config points to this server.
