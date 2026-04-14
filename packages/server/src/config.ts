import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(4001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Gateway
  GATEWAY_URL: z.string().url().default('http://localhost:3000'),
  GATEWAY_TIMEOUT_MS: z.coerce.number().default(10000),
  GATEWAY_HOST: z.string().default(''),
  // Public, browser-reachable gateway URL for frontend assets (image previews, raw data links).
  // Falls back to https://${GATEWAY_HOST} if unset, then to https://turbo-gateway.com.
  PUBLIC_GATEWAY_URL: z.string().default(''),

  // Database
  SQLITE_PATH: z.string().default('./data/verify.db'),

  // Attestation signing (optional — skip if not set)
  SIGNING_KEY_PATH: z.string().default(''),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }

  const config = result.data;
  validateDockerGateway(config);
  return config;
}

export const config = loadConfig();

/**
 * Resolve the browser-reachable gateway URL.
 * Order: PUBLIC_GATEWAY_URL → https://${GATEWAY_HOST} → https://turbo-gateway.com.
 * Returned URL has no trailing slash.
 */
export function resolvePublicGatewayUrl(): string {
  const raw =
    config.PUBLIC_GATEWAY_URL ||
    (config.GATEWAY_HOST ? `https://${config.GATEWAY_HOST}` : 'https://turbo-gateway.com');
  return raw.replace(/\/$/, '');
}

function isRunningInDocker(): boolean {
  if (process.env.DOCKER || process.env.CONTAINER) {
    return true;
  }

  if (existsSync('/.dockerenv')) {
    return true;
  }

  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
    return (
      cgroup.includes('docker') || cgroup.includes('containerd') || cgroup.includes('kubepods')
    );
  } catch {
    return false;
  }
}

function isLocalhostHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower.endsWith('.localhost')
  );
}

function validateDockerGateway(config: Config): void {
  if (!isRunningInDocker()) {
    return;
  }

  try {
    const url = new URL(config.GATEWAY_URL);
    if (isLocalhostHost(url.hostname)) {
      console.error(
        'Invalid GATEWAY_URL for Docker: localhost resolves to the container itself. ' +
          'Use the gateway service hostname (e.g. http://core:4000).'
      );
      process.exit(1);
    }
  } catch {
    console.error('Invalid GATEWAY_URL configuration.');
    process.exit(1);
  }
}
