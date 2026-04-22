#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$SCRIPT_DIR"

REBUILD=false
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=true ;;
    -h|--help)
      cat <<EOF
Usage: bash start.sh [--rebuild]

  --rebuild   Force a Docker image rebuild before launching. Use this after
              pulling code changes. Without it, an existing ar-io-verify:local
              image is reused as-is.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (use --help)" >&2
      exit 1
      ;;
  esac
done

cd "$DEPLOY_DIR"

# Create .env from example on first run and exit so the user can edit it.
# Defaults in .env.example almost never match a real deployment (gateway
# container name, host path to wallet, domain). Launching with unedited
# defaults silently produces a sidecar that can't reach its gateway.
if [ ! -f .env ]; then
  cp .env.example .env
  cat <<EOF
Created $DEPLOY_DIR/.env from .env.example.

Edit it before launching:
  - GATEWAY_URL    envoy container on ar-io-network (see: docker ps --filter network=ar-io-network)
  - GATEWAY_HOST   your public domain (used in attestation payloads)
  - WALLET_FILE    host path to your Arweave JWK wallet (optional; leave empty to skip attestations)

Then re-run: bash start.sh
EOF
  exit 0
fi

source .env

# Validate WALLET_FILE before Docker gets a chance to error cryptically on a
# missing bind-mount source. Empty value is fine — attestation just disabled.
if [ -n "${WALLET_FILE:-}" ] && [ ! -f "$WALLET_FILE" ]; then
  echo "ERROR: WALLET_FILE is set to '$WALLET_FILE' but that file does not exist."
  echo "       Set WALLET_FILE to a valid JWK wallet path, or leave it empty to disable attestation signing."
  exit 1
fi

# Check ar-io-network exists
if ! docker network inspect ar-io-network >/dev/null 2>&1; then
  echo "ERROR: ar-io-network does not exist. Start your AR.IO gateway first."
  exit 1
fi

# Build the image when requested, or when missing.
IMAGE="${VERIFY_IMAGE:-ar-io-verify:local}"
IMAGE_EXISTS=true
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  IMAGE_EXISTS=false
fi

if [[ "$IMAGE" == *":local"* ]] && ( [ "$REBUILD" = true ] || [ "$IMAGE_EXISTS" = false ] ); then
  echo "Building ar-io-verify image from repo..."
  docker build -f "$REPO_ROOT/Dockerfile" -t "$IMAGE" "$REPO_ROOT"
elif [ "$REBUILD" = true ]; then
  echo "Note: --rebuild ignored because VERIFY_IMAGE=$IMAGE is not a :local tag."
fi

# If we rebuilt, force-recreate the sidecar so it picks up the new image.
if [ "$REBUILD" = true ]; then
  docker compose up -d --force-recreate verify-sidecar
  docker compose up -d verify-proxy
else
  docker compose up -d
fi

echo ""
echo "ar.io Verify is starting."
echo "  UI:     http://localhost:${VERIFY_PORT:-4001}/verify/"
echo "  API:    http://localhost:${VERIFY_PORT:-4001}/api"
echo "  Health: http://localhost:${VERIFY_PORT:-4001}/health"

# Pre-flight: wait briefly for the sidecar to come up, then probe gateway reach.
# We check from inside the sidecar container (via `compose exec`, which resolves
# the container name regardless of project name) because GATEWAY_URL uses a
# Docker-network hostname that isn't resolvable from the host.
echo ""
echo "Checking gateway reachability..."
for i in 1 2 3 4 5; do
  if docker compose exec -T verify-sidecar sh -c 'curl -f -s --max-time 3 "$GATEWAY_URL/ar-io/info" >/dev/null' 2>/dev/null; then
    echo "  OK — gateway reachable at $GATEWAY_URL"
    break
  fi
  if [ "$i" = 5 ]; then
    echo "  WARNING: gateway not reachable at $GATEWAY_URL after 5 attempts."
    echo "           The sidecar is running but will return gateway:false on /health."
    echo "           Check that your gateway container is up and that GATEWAY_URL points at it."
  else
    sleep 2
  fi
done

echo ""
echo "Logs: docker compose -f $DEPLOY_DIR/docker-compose.yaml logs -f"
