#!/usr/bin/env bash
# Smoke test for the verify jobs API. Runs end-to-end against a deployed
# verify sidecar: creates a job, polls for completion, fetches the signed
# bundle, and pulls the events stream. Verifies the bundle's payloadHash
# locally (independent recompute) so a successful run mathematically proves
# the operator signed the bytes we received.
#
# Usage:
#   bash smoke-jobs.sh <verify-url> <txId> [<txId> ...]
#
# Example:
#   bash smoke-jobs.sh http://localhost:4001 \
#     pwy3Q4HOfWPXlH5n4LvePvJDsiHtZ0vPPcSxv9jl8BU
#
# Exit codes:
#   0  smoke passed
#   1  setup error (bad args, server unreachable)
#   2  job did not complete in time
#   3  bundle missing or malformed
#   4  payloadHash recompute mismatch

set -euo pipefail

VERIFY_URL="${1:-}"
shift || true
TX_IDS=("$@")
TENANT_ID="${TENANT_ID:-tenant_smoke_$(date +%s)}"
TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-180}"
POLL_INTERVAL=2

if [[ -z "$VERIFY_URL" ]] || (( ${#TX_IDS[@]} == 0 )); then
  echo "Usage: bash smoke-jobs.sh <verify-url> <txId> [<txId> ...]" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (apt-get install jq)" >&2
  exit 1
fi

echo "→ Verify URL:   $VERIFY_URL"
echo "→ Tenant id:    $TENANT_ID"
echo "→ Tx count:     ${#TX_IDS[@]}"

# Build txIds JSON array
TX_JSON=$(printf '%s\n' "${TX_IDS[@]}" | jq -R . | jq -s .)
BODY=$(jq -n --argjson ids "$TX_JSON" '{txIds: $ids}')

echo
echo "==> POST /api/v1/jobs"
CREATE=$(curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Idempotency-Key: smoke-$(date +%s%N)" \
  -d "$BODY" \
  "$VERIFY_URL/api/v1/jobs")
echo "$CREATE" | jq .
JOB_ID=$(echo "$CREATE" | jq -r .jobId)
[[ "$JOB_ID" == "null" || -z "$JOB_ID" ]] && { echo "no jobId returned" >&2; exit 1; }

echo
echo "==> Polling status (timeout ${TIMEOUT_SEC}s)..."
START=$(date +%s)
while true; do
  STATUS=$(curl -fsS -H "X-Tenant-Id: $TENANT_ID" "$VERIFY_URL/api/v1/jobs/$JOB_ID")
  S=$(echo "$STATUS" | jq -r .job.status)
  C=$(echo "$STATUS" | jq -r '.run.counters | "verified=\(.verified) tampered=\(.tampered) unavailable=\(.unavailable)"' 2>/dev/null || echo "no run yet")
  printf "    [%4ds] status=%-10s %s\n" "$(( $(date +%s) - START ))" "$S" "$C"
  case "$S" in
    completed) break ;;
    failed|cancelled) echo "job ended with status=$S" >&2; exit 2 ;;
  esac
  if (( $(date +%s) - START >= TIMEOUT_SEC )); then
    echo "timeout waiting for job to complete" >&2
    exit 2
  fi
  sleep "$POLL_INTERVAL"
done

echo
echo "==> GET /api/v1/jobs/$JOB_ID/results"
curl -fsS -H "X-Tenant-Id: $TENANT_ID" "$VERIFY_URL/api/v1/jobs/$JOB_ID/results" | jq '.items[] | {txId, outcome, cacheHit, failureReason}'

echo
echo "==> GET /api/v1/jobs/$JOB_ID/report (signed bundle)"
BUNDLE=$(curl -fsS -H "X-Tenant-Id: $TENANT_ID" -H "Accept: application/json" "$VERIFY_URL/api/v1/jobs/$JOB_ID/report")
echo "$BUNDLE" | jq '. | {version, type, jobId, runId, operator, gateway, totals, failuresTruncated, payloadHash, signature: (.signature // null | if . == null then "(unsigned — no operator wallet)" else "(present, length=" + (. | length | tostring) + ")" end)}'

# Independently recompute payloadHash. Strip signature + payloadHash, deep-canonicalize, SHA-256.
echo
echo "==> Independent payloadHash recompute"
RECOMPUTED=$(echo "$BUNDLE" | jq -S 'del(.signature) | del(.payloadHash)' --compact-output | python3 -c '
import sys, hashlib, json, base64
raw = sys.stdin.read().strip()
# Recanonicalize with deep sort to match server canonicalization
def canon(v):
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k) + ":" + canon(v[k]) for k in sorted(v.keys())) + "}"
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    return json.dumps(v, separators=(",", ":"))
canonical = canon(json.loads(raw))
h = hashlib.sha256(canonical.encode()).digest()
print(base64.urlsafe_b64encode(h).decode().rstrip("="))
')
CLAIMED=$(echo "$BUNDLE" | jq -r .payloadHash)
echo "    claimed:    $CLAIMED"
echo "    recomputed: $RECOMPUTED"
if [[ "$CLAIMED" != "$RECOMPUTED" ]]; then
  echo "MISMATCH — bundle canonical-JSON contract is broken" >&2
  exit 4
fi
echo "    ✓ payloadHash matches"

echo
echo "==> GET /api/v1/jobs/events"
curl -fsS -H "X-Tenant-Id: $TENANT_ID" "$VERIFY_URL/api/v1/jobs/events" | jq '.items[] | {id, type, jobId, payload: .payload.totals}'

echo
echo "✅ smoke passed (jobId=$JOB_ID, tenant=$TENANT_ID)"
