import { config } from '../config.js';

/**
 * Process-wide semaphore over outbound gateway fetches. All gateway client
 * calls (HEAD, GET, range, GraphQL) acquire a permit before fetching and
 * release it after. Capped by config.GATEWAY_MAX_INFLIGHT.
 *
 * Why one global budget instead of per-job concurrency caps: a single user
 * submitting a 100k-tx job can monopolize the event loop and the gateway's
 * connection capacity. A shared budget is the right primitive — interactive
 * verifies and batch jobs queue against the same limit.
 *
 * Future: per-org fair-share split (see task #21+). For MVP, FIFO suffices
 * because api-guard rate-limits at the org level upstream.
 */
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  inflight(): number {
    return this.waiting.length;
  }
}

// Fall back to a sane default if GATEWAY_MAX_INFLIGHT is missing (e.g., in
// tests that mock config with a partial shape). With permits=undefined the
// semaphore would block forever — silent deadlock is worse than a small
// default that gets overridden in production.
const budget = new Semaphore(config.GATEWAY_MAX_INFLIGHT ?? 32);

export async function withGatewayBudget<T>(fn: () => Promise<T>): Promise<T> {
  await budget.acquire();
  try {
    return await fn();
  } finally {
    budget.release();
  }
}

export function gatewayBudgetWaiting(): number {
  return budget.inflight();
}
