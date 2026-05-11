import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { gatewayBudgetQueueDepth } from '../gateway/budget.js';
import { isSigningEnabled } from './signing.js';

/**
 * Single metrics registry. Default Node metrics (CPU, mem, GC, event loop
 * lag) are collected automatically. Domain metrics are bumped from the
 * worker, gateway client, and route handlers.
 *
 * Cardinality discipline: tenant_id is NEVER a label — it would explode
 * the time-series count on any non-trivial customer base. Per-tenant
 * accounting belongs at the api-guard layer; verify exposes aggregate
 * health/throughput metrics only.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'verify_' });

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

export const jobsCreated = new Counter({
  name: 'verify_jobs_created_total',
  help: 'Number of verification jobs created (deduplicated by Idempotency-Key per tenant).',
  registers: [registry],
  labelNames: ['deduplicated'] as const,
});

export const runsCompleted = new Counter({
  name: 'verify_runs_total',
  help: 'Number of job runs that reached a terminal state, labeled by status.',
  registers: [registry],
  labelNames: ['status'] as const, // 'completed' | 'failed' | 'cancelled'
});

export const runDuration = new Histogram({
  name: 'verify_run_duration_seconds',
  help: 'Time from run start to terminal state.',
  registers: [registry],
  buckets: [0.5, 1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
});

// ---------------------------------------------------------------------------
// Per-tx outcomes
// ---------------------------------------------------------------------------

export const txOutcomes = new Counter({
  name: 'verify_tx_outcomes_total',
  help: 'Per-tx verification outcomes (across both single-tx and batch paths).',
  registers: [registry],
  labelNames: ['outcome', 'cache_hit'] as const, // outcome: verified|tampered|unavailable
});

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export const gatewayRequests = new Counter({
  name: 'verify_gateway_requests_total',
  help: 'Outbound gateway HTTP requests, labeled by coarse result.',
  registers: [registry],
  labelNames: ['endpoint', 'result'] as const,
  // endpoint: 'tx' | 'raw_head' | 'raw_get' | 'raw_range' | 'graphql' | 'health'
  // result:   'ok' | '4xx' | '5xx' | 'timeout' | 'error'
});

export const gatewayRequestDuration = new Histogram({
  name: 'verify_gateway_request_duration_seconds',
  help: 'Outbound gateway request latency.',
  registers: [registry],
  labelNames: ['endpoint'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

// ---------------------------------------------------------------------------
// Live state (gauges with collectors so they reflect current state at scrape)
// ---------------------------------------------------------------------------

new Gauge({
  name: 'verify_gateway_queue_depth',
  help: 'Number of outbound gateway fetches parked waiting for a budget permit.',
  registers: [registry],
  collect() {
    this.set(gatewayBudgetQueueDepth());
  },
});

new Gauge({
  name: 'verify_signing_enabled',
  help: '1 if the operator signing wallet is loaded, 0 otherwise.',
  registers: [registry],
  collect() {
    this.set(isSigningEnabled() ? 1 : 0);
  },
});

export const inflightJobs = new Gauge({
  name: 'verify_inflight_jobs',
  help: 'Number of jobs currently being processed by the worker pool.',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// HTTP request metrics (set by the access-log middleware)
// ---------------------------------------------------------------------------

export const httpRequests = new Counter({
  name: 'verify_http_requests_total',
  help: 'HTTP requests by route family and status class.',
  registers: [registry],
  labelNames: ['route', 'status_class'] as const,
});

export const httpRequestDuration = new Histogram({
  name: 'verify_http_request_duration_seconds',
  help: 'HTTP request latency from receive to response finish.',
  registers: [registry],
  labelNames: ['route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
