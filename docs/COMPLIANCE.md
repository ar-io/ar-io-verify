# Verification Bundle V2 — Compliance Map

This document maps fields of the `VerificationBundle` V2 artifact (and the
single-tx PDF certificate) to the regulatory and audit frameworks they
satisfy. It is the source of truth for the `conformance[]` field on every
signed bundle.

For the canonical schema, see [`packages/server/schemas/v2/bundle.json`](../packages/server/schemas/v2/bundle.json). For a reference offline verifier, see [`packages/verifier-cli`](../packages/verifier-cli).

---

## Frameworks claimed and how

### EU AI Act (Regulation (EU) 2024/1689) — binding 2 Aug 2026

| Clause                 | Requirement                                                                 | How V2 satisfies it                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Art. 10(2)(b)**      | Data governance — origin of data                                            | `results.verified[].owner`, `results.verified[].blockHeight`, `results.verified[].blockTimestamp`, plus `recovery.arweave` weave pointer prove the on-chain origin of every verified tx                                                                                                                                               |
| **Art. 11 + Annex IV** | Technical documentation must include datasets used + data provenance        | The bundle (canonical JSON + signature) is itself the technical-file evidence artifact                                                                                                                                                                                                                                                |
| **Art. 12**            | Automatic event logs, tamper-evident, timestamped, independently verifiable | Operator RSA-PSS signature over canonical JSON (`signature` + `payloadHash`), `validity.producedAt`, per-tx Merkle binding (`results.txMerkleRoot`) — independently verifiable via `packages/verifier-cli`. ⚠️ Timestamps come from `validity.timeSource: "system-clock"` — RFC 3161 trusted timestamps are a documented Phase-2 gap. |
| **Art. 13(2)**         | Transparency to deployers — concise, complete, correct, clear               | `humanReadable.summary` (plain-language verdict), `humanReadable.limitations` (what the report does NOT say), `humanReadable.howToReverify`. PDF mirrors the same three sections.                                                                                                                                                     |
| **Art. 13(3)(b)(iii)** | Limitations of the system disclosed                                         | `methodology.knownLimitations[]` + `humanReadable.limitations`                                                                                                                                                                                                                                                                        |
| **Art. 19**            | Logs retained ≥6 months                                                     | `validity.retentionPolicy: "P6M"` default (configurable via `BUNDLE_RETENTION_MONTHS`), `validity.validFrom` / `validity.validUntil` carry the explicit window                                                                                                                                                                        |

### ISO/IEC 42001:2023 — AI Management Systems

| Annex B Control                                 | How V2 satisfies it                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **A.7.2 Data acquisition / provenance**         | `results.verified[].owner`, `blockHeight`, `blockTimestamp`, `recovery.arweave`                    |
| **A.7.3 Data quality**                          | `methodology.checks`, `methodology.assuranceLevel: cryptographic-proof`                            |
| **A.7.4 Data preparation / transformation log** | The bundle is itself an immutable record of one transformation: input txIds → verified outcomes    |
| **A.7.5 Traceability**                          | `id: urn:ar-io-verify:job_xxx:run_yyy` is a stable URN; `subject.input.ids` lists every covered tx |
| **A.7.6 Audit logs**                            | `validity.producedAt` + signature anchor every claim to a point in time and an operator            |

### NIST AI Risk Management Framework 1.0 (+ 2025 update, NIST AI 600-1 GenAI Profile)

| RMF Function                        | How V2 satisfies it                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MAP-4 (data lineage)**            | `recovery.arweave.txId / weaveOffset / weaveSize` lets a customer recover the original bytes from the Arweave network independently                                  |
| **MEASURE-2.7 (reproducibility)**   | `methodology.referenceVerifier` URL + `methodology.canonicalization: RFC8785` + bundled JSON Schema make the result re-derivable offline                             |
| **GOVERN (third-party assessment)** | `issuer.independence: third-party-from-data-owner` declares the relationship; `issuer.trustAnchor: self-asserted-arweave-wallet` discloses what the trust depends on |

### NIST SP 800-86 — Forensic chain of custody

| Requirement                             | How V2 satisfies it                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Hash at every transfer/imaging step     | `results.verified[].dataSha256` records the independent SHA-256 of bytes verified; `recovery.arweave` lets a third party fetch and recompute |
| Documented custodian + time             | `issuer.operator` + `validity.producedAt`                                                                                                    |
| Analysis on copies, not originals       | The bundle attests work done on data downloaded from `issuer.gateway` — not modifying the on-chain originals                                 |
| ⚠️ Full hop log (who/when/hash per hop) | Not yet emitted as an explicit `chainOfCustody[]` array — Phase-2 work                                                                       |

### W3C Verifiable Credentials 2.0 (REC, May 2025)

V2 adopts the **structural conventions** of VC 2.0 without committing to full JSON-LD processing:

| VC 2.0 field                    | V2 field                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@context`                      | `@context`                                                                                       |
| `type`                          | `type` (constant `"VerificationBundle"`)                                                         |
| `issuer`                        | `issuer.operator` + `issuer.operatorPublicKey`                                                   |
| `validFrom`, `validUntil`       | `validity.validFrom`, `validity.validUntil`                                                      |
| `credentialSubject`             | `subject`                                                                                        |
| `proof` (Data Integrity / JOSE) | `payloadHash` + `signature` + `signatureAlgorithm` (RSA-PSS-SHA256 over RFC 8785 canonical JSON) |
| `credentialSchema`              | `$schema`                                                                                        |

Claimed as `vc-2.0-structural` in `conformance[]` — not the stronger `vc-2.0-conformant` because we don't implement JSON-LD context resolution.

### C2PA 2.x (Coalition for Content Provenance and Authenticity)

| C2PA element             | V2 analogue                                                              |
| ------------------------ | ------------------------------------------------------------------------ |
| Claim Generator          | `issuer.gateway.host` + `issuer.gateway.softwareVersion`                 |
| Claim Signature          | `signature` (RSA-PSS-SHA256)                                             |
| Hard binding hash        | `results.verified[].dataSha256` per row + `payloadHash` over the whole   |
| Assertions               | `results.verified[]` rows are assertions about specific txIds            |
| Trust list anchor        | ⚠️ Self-asserted Arweave wallet — not yet C2PA Trust List or eIDAS QSeal |
| Time-stamping (RFC 3161) | ⚠️ Phase-2 gap                                                           |

Claimed as `c2pa-2.x-aligned` — structural parity, but not COSE/CBOR-encoded and not yet on the C2PA Trust List.

### ISAE 3000 (Revised) / PCAOB AS 1105 .10A (effective FY2025+)

The bundle is **third-party evidence** to be consumed by CPA assurance work, not an assurance report itself.

| Requirement                                                   | How V2 supports the auditor                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Reliability of external electronic information (AS 1105 .10A) | `issuer.trustAnchor` discloses the trust model; reference verifier proves the artifact wasn't tampered    |
| Source identification                                         | `issuer.operator` + `issuer.gateway`                                                                      |
| Process understandability                                     | `methodology` block names every check and every algorithm                                                 |
| Information testability                                       | `methodology.referenceVerifier` URL + `humanReadable.howToReverify` give the auditor an executable recipe |
| Independence disclosure                                       | `issuer.independence: third-party-from-data-owner`                                                        |

### RFC 8785 (JSON Canonicalization Scheme) — adopted

Every byte the operator signs goes through `packages/server/src/utils/canonical.ts`, which implements the §3 rules of RFC 8785: UTF-16 code-unit key sort, ECMAScript number serialization, undefined-member drop. Cross-language verifier compatibility (Python `pyjcs`, Go `gowebpki/jcs`, Rust `serde-jcs`) is assured by adopting the standard rather than rolling our own.

The reference verifier in `packages/verifier-cli/src/canonical.mjs` is an **independent re-implementation** of the same spec — an auditor can diff the two files and confirm semantic equivalence.

---

## Known gaps (Phase 2+)

These are honest gaps in V2's compliance posture. They are documented here, in `methodology.knownLimitations[]`, and in `humanReadable.limitations`.

| Gap                                          | Frameworks affected                                                                 | Mitigation                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| No RFC 3161 trusted timestamp                | EU AI Act Art. 12 (strong tamper-evidence), eIDAS PAdES/JAdES LTV, C2PA recommended | `validity.timeSource: "system-clock"` declares the limitation honestly. Phase-2 work item.                              |
| No qualified certificate / CA-anchored trust | eIDAS QSeal, C2PA Trust List                                                        | `issuer.trustAnchor: "self-asserted-arweave-wallet"` discloses the trust model. Phase-3+ work item.                     |
| No explicit chain-of-custody hop log         | NIST SP 800-86 §6.2                                                                 | Hops are implicit in `issuer.gateway` + `methodology.checks`. Explicit `chainOfCustody[]` array is a Phase-2 work item. |
| No JSON-LD context resolution                | W3C VC 2.0 conformant (only structural)                                             | `@context` URL is dereferenceable but we don't process it. Phase-3+ work item.                                          |
| No COSE/CBOR signing                         | C2PA 2.x conformant (only aligned)                                                  | Phase-3+ work item — parallel C2PA manifest emission.                                                                   |
| Single-process worker only                   | High-availability assurance                                                         | Documented in CLAUDE.md; horizontal scaling is post-MVP federation.                                                     |

---

## How to re-verify a bundle offline

```bash
# From the repo:
node packages/verifier-cli/bin/reverify.mjs path/to/bundle.json

# Or, after publishing:
npx @ar-io/verifier-cli bundle.json
```

Reports per-step PASS/FAIL with detail:

```
Bundle: bundle.json
Id:     urn:ar-io-verify:job_abc:run_xyz
Issuer: 7p90oV...
Result: PASS

[OK]   bundle has all required V2 fields
        shape ok
[OK]   payloadHash matches recomputed SHA-256 of canonical(bundle - {payloadHash, signature})
        eM13dSb...
[OK]   txMerkleRoot matches recomputed Merkle root over enumerated entries
        47DEQpj...
[OK]   signature verifies as RSA-PSS-SHA256 under issuer.operatorPublicKey
        signature valid
```

Exit code 0 = PASS, 1 = FAIL on any step, 2 = bad input.

---

## Versioning policy

The bundle schema follows monotonic integer versions in `version`. **Breaking changes bump the integer**, never the URL path — `$schema` always points at the current schema URL, and old verifiers see a fail-shape step rather than silently misinterpreting.

V2 is the first audit-grade schema. V1 was a development-only structure (`type: "verify.bundle.run"`); it is removed in this PR and is not parsed by any current consumer.
