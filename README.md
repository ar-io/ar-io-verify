# ar.io Verify

A verification sidecar for [ar.io](https://ar.io) gateways. Runs alongside your gateway and independently proves that data served from Arweave is authentic, untampered, and attributable to a specific owner.

When a user or application asks "is this data real?", the sidecar downloads the raw data from the gateway, reconstructs the cryptographic proof from scratch, and returns a verification result. If the gateway operator has configured a signing wallet, the result is also signed as an attestation — a cryptographic statement from the operator that they personally verified the data.

## How Verification Works

Verification happens in three stages. Each stage builds on the previous one, and the result is assigned a level based on the strongest proof achieved.

### Stage 1 — Existence (Level 1)

The sidecar confirms the transaction exists on the Arweave blockweave by querying the gateway's GraphQL index and checking `/raw/` headers. If the transaction is found in a confirmed block, we know the data was accepted by the network at a specific block height and timestamp.

**What this proves:** the data exists on Arweave and was mined into a block.

### Stage 2 — Data Integrity (Level 2)

The sidecar downloads the full raw data from the gateway and computes its SHA-256 hash independently. This fingerprint can be compared against the gateway's reported digest to confirm consistency.

**What this proves:** the data the gateway served has a known fingerprint. Note that this stage alone does not anchor the hash to anything on-chain — it confirms the gateway served consistent bytes, but the real integrity guarantee comes from Stage 3.

### Stage 3 — Signature Verification (Level 3)

The sidecar reconstructs the exact message that the original signer signed (the "deep hash") from the transaction's constituent parts — owner, target, tags, and data. It then verifies the cryptographic signature against that message using the appropriate algorithm:

- **RSA-PSS** (type 1) — Arweave native wallets
- **ED25519** (type 2) — Solana wallets
- **ECDSA secp256k1** (type 3) — Ethereum wallets

For bundled data items (ANS-104), the sidecar fetches the binary header from the root bundle via a range request to get the exact original tag bytes, since re-encoded tags from GraphQL can differ from the signed original.

**What this proves:** the stated owner cryptographically signed this exact data. The data is authentic and has not been modified since signing. This is a mathematical proof, not a trust claim.

### Operator Attestation

When a gateway operator configures their Arweave wallet (`WALLET_FILE`), the sidecar signs the verification result with the operator's private key. This creates an attestation — a statement from a known operator on the ar.io network that they independently verified the data. Anyone can check this attestation by verifying the RSA-PSS signature against the operator's public key.

## Quick Start

```bash
git clone https://github.com/ar-io/ar-io-verify.git
cd ar-io-verify
pnpm install
pnpm run dev
```

## Deployment

Runs as a sidecar alongside an ar.io gateway on the same Docker network (`ar-io-network`).

```bash
cd deploy
cp .env.example .env   # edit GATEWAY_URL, WALLET_FILE, GATEWAY_HOST
bash start.sh
```

### Environment Variables

| Variable             | Default                          | Description                                                               |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `GATEWAY_URL`        | `http://ar-io-node-envoy-1:3000` | ar.io gateway URL (must be reachable from the container)                  |
| `GATEWAY_HOST`       | (empty)                          | Gateway hostname included in attestation payloads (e.g. `vilenarios.com`) |
| `WALLET_FILE`        | (empty)                          | Host path to Arweave JWK wallet for signing attestations                  |
| `VERIFY_PORT`        | `4001`                           | Public port for the verify UI and API                                     |
| `GATEWAY_TIMEOUT_MS` | `10000`                          | Gateway request timeout                                                   |
| `LOG_LEVEL`          | `info`                           | Log level: debug, info, warn, error                                       |

### Nginx Configuration

To expose via your domain:

```nginx
location /local/verify/ {
    proxy_pass http://your-server:4001/verify/;
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

## API

Interactive docs: `/api-docs/`

| Method | Path                             | Description                                   |
| ------ | -------------------------------- | --------------------------------------------- |
| `POST` | `/api/v1/verify`                 | Verify a transaction                          |
| `GET`  | `/api/v1/verify/:id`             | Get cached result                             |
| `GET`  | `/api/v1/verify/tx/:txId`        | Get history for a transaction                 |
| `GET`  | `/api/v1/verify/:id/pdf`         | Download PDF certificate                      |
| `GET`  | `/api/v1/verify/:id/attestation` | Get attestation for programmatic verification |
| `GET`  | `/raw/:txId`                     | Proxy raw data from gateway                   |
| `GET`  | `/health`                        | Health check                                  |
| `GET`  | `/api-docs/`                     | Swagger UI                                    |

## Architecture

```
packages/
  server/    Express API — verification pipeline, PDF certificates, SQLite cache
  web/       React frontend — Vite, Tailwind CSS, served at /verify/
deploy/      Docker Compose + nginx reverse proxy
```

### Verification Pipeline

```
1. HEAD /raw/{txId} + GraphQL    — parallel (~50ms)
2. Determine L1 tx vs data item
3. Download raw data + binary header fetch (range request)
4. Deep hash reconstruction → signature verify (RSA-PSS / ED25519 / ECDSA)
5. Operator attestation (if wallet configured)
```

### Attestation

When `WALLET_FILE` is set, the operator's wallet signs a canonical attestation payload:

```json
{
  "version": 1,
  "txId": "...",
  "dataHash": "...",
  "signatureVerified": true,
  "ownerAddress": "...",
  "blockHeight": 888672,
  "operator": "7p90oVDW...",
  "gateway": "vilenarios.com",
  "attestedAt": "2026-04-08T..."
}
```

To verify: pass the canonical JSON (keys sorted alphabetically, no whitespace) to a standard RSA-PSS SHA-256 verifier with the operator's public key.

## Testing

```bash
pnpm run test
```

## Console Integration

The verify feature is also available as a tool in the [ar.io Console](https://github.com/ar-io/ar-io-console) at `/verify`.

## License

AGPL-3.0
