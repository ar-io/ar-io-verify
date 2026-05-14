import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  METHODOLOGY_VERIFIED,
  METHODOLOGY_BASIC,
  existenceStatement,
  authenticityStatement,
  bundleStatement,
  gatewayAssessmentStatement,
  plainLanguageSummary,
  PDF_LIMITATIONS,
  PDF_HOW_TO_REVERIFY,
  recoveryStatement,
} from './templates.js';
import { BUNDLE_CONFORMANCE, CANONICALIZATION_SPEC } from './compliance.js';
import { SERVER_VERSION } from '../version.js';
import { config } from '../config.js';
import type { VerificationResult } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load custom fonts once — check multiple locations (src/ for dev, dist/ for production)
let besleyBytes: Uint8Array | null = null;
let jakartaBytes: Uint8Array | null = null;
const fontPaths = [
  join(__dirname, 'fonts'), // dist/fonts/ (production Docker)
  join(__dirname, '..', 'src', 'attestation', 'fonts'), // from dist/ → src/ (dev)
  join(__dirname, 'attestation', 'fonts'), // src/attestation/fonts/ (tsx dev)
];
for (const dir of fontPaths) {
  try {
    besleyBytes = readFileSync(join(dir, 'Besley.ttf'));
    jakartaBytes = readFileSync(join(dir, 'PlusJakartaSans.ttf'));
    break;
  } catch {
    // Try next path
  }
}

const MARGIN = 50;
const PAGE_WIDTH = 595; // A4
const PAGE_HEIGHT = 842;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const LEVEL_LABELS: Record<number, string> = {
  3: 'Complete Verification (Level 3)',
  2: 'Strong Verification (Level 2)',
  1: 'Partial Verification (Level 1)',
};

const LEVEL_COLORS: Record<number, ReturnType<typeof rgb>> = {
  3: rgb(0.0, 0.5, 0.0),
  2: rgb(0.33, 0.15, 0.78),
  1: rgb(0.7, 0.5, 0.0),
};

export async function generatePdf(result: VerificationResult): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  // Use ar.io brand fonts if available, fall back to Helvetica
  let fontRegular: PDFFont;
  let fontBold: PDFFont;
  try {
    fontRegular = jakartaBytes
      ? await doc.embedFont(jakartaBytes)
      : await doc.embedFont(StandardFonts.Helvetica);
    fontBold = besleyBytes
      ? await doc.embedFont(besleyBytes)
      : await doc.embedFont(StandardFonts.HelveticaBold);
  } catch {
    // Custom font embedding failed — use standard fonts
    fontRegular = await doc.embedFont(StandardFonts.Helvetica);
    fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  }

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  // Header
  y = drawText(page, 'Verification Certificate', fontBold, 20, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 8;
  y = drawText(
    page,
    LEVEL_LABELS[result.level],
    fontBold,
    12,
    MARGIN,
    y,
    LEVEL_COLORS[result.level]
  );
  y -= 16;
  y = drawText(
    page,
    `Verification ID: ${result.verificationId}`,
    fontRegular,
    9,
    MARGIN,
    y,
    rgb(0.3, 0.3, 0.3)
  );
  y -= 4;
  y = drawText(page, `Date: ${result.timestamp}`, fontRegular, 9, MARGIN, y, rgb(0.3, 0.3, 0.3));
  y -= 4;
  y = drawText(page, `Transaction: ${result.txId}`, fontRegular, 9, MARGIN, y, rgb(0.3, 0.3, 0.3));
  y -= 20;

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 20;

  // Plain-language Summary — leads the report so a non-technical auditor
  // can absorb the verdict before getting into the cryptographic detail.
  // EU AI Act Art. 13 + Plain Writing Act tone.
  y = drawText(page, 'Summary', fontBold, 13, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 8;
  const summaryResult = drawWrappedText(
    page,
    doc,
    plainLanguageSummary(result),
    fontRegular,
    9,
    MARGIN,
    y,
    CONTENT_WIDTH,
    13,
    rgb(0.15, 0.15, 0.15)
  );
  page = summaryResult.page;
  y = summaryResult.y;
  y -= 20;

  // Methodology
  y = drawText(page, 'Methodology', fontBold, 13, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 8;
  const methodology = result.level >= 3 ? METHODOLOGY_VERIFIED : METHODOLOGY_BASIC;
  const mResult = drawWrappedText(
    page,
    doc,
    methodology,
    fontRegular,
    9,
    MARGIN,
    y,
    CONTENT_WIDTH,
    13,
    rgb(0.2, 0.2, 0.2)
  );
  page = mResult.page;
  y = mResult.y;
  y -= 20;

  // Statement of Facts
  y = drawText(page, 'Statement of Facts', fontBold, 13, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 10;

  const checksPass = result.authenticity.status === 'signature_verified';
  const facts = [
    existenceStatement(result.txId, result.existence.blockHeight, result.existence.blockTimestamp),
    authenticityStatement(result.authenticity, result.owner),
    bundleStatement(result.bundle.isBundled, result.bundle.rootTransactionId),
    gatewayAssessmentStatement(result.gatewayAssessment, checksPass),
  ].filter(Boolean);

  for (const fact of facts) {
    if (y < MARGIN + 60) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    const fResult = drawWrappedText(
      page,
      doc,
      fact,
      fontRegular,
      9,
      MARGIN,
      y,
      CONTENT_WIDTH,
      13,
      rgb(0.15, 0.15, 0.15)
    );
    page = fResult.page;
    y = fResult.y;
    y -= 12;
  }
  y -= 8;

  // Evidence Summary Table
  if (y < MARGIN + 160) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y = drawText(page, 'Evidence Summary', fontBold, 13, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 14;

  const rows = buildEvidenceRows(result);
  y = drawTableRow(
    page,
    fontBold,
    9,
    MARGIN,
    y,
    ['Check', 'Result', 'Detail'],
    [160, 80, CONTENT_WIDTH - 240],
    rgb(0.9, 0.9, 0.9)
  );
  for (const row of rows) {
    if (y < MARGIN + 30) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    y = drawTableRow(page, fontRegular, 8, MARGIN, y, row, [160, 80, CONTENT_WIDTH - 240], null);
  }
  y -= 20;

  // Appendix
  if (y < MARGIN + 120) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y = drawText(page, 'Cryptographic Proof Appendix', fontBold, 13, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 10;

  const appendix = [
    `Transaction ID: ${result.txId}`,
    `Verification Level: ${result.level} (${LEVEL_LABELS[result.level]})`,
    `Authenticity: ${result.authenticity.status}`,
    result.existence.blockHeight ? `Block Height: ${result.existence.blockHeight}` : null,
    result.existence.blockId ? `Block ID: ${result.existence.blockId}` : null,
    result.existence.blockTimestamp ? `Block Timestamp: ${result.existence.blockTimestamp}` : null,
    result.owner.address ? `Owner Address: ${result.owner.address}` : null,
    result.authenticity.dataHash ? `Data SHA-256: ${result.authenticity.dataHash}` : null,
    result.authenticity.gatewayHash ? `Gateway SHA-256: ${result.authenticity.gatewayHash}` : null,
    result.gatewayAssessment.hops !== null ? `Data Hops: ${result.gatewayAssessment.hops}` : null,
  ].filter(Boolean) as string[];

  for (const line of appendix) {
    if (y < MARGIN + 20) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    y = drawText(page, line, fontRegular, 8, MARGIN, y, rgb(0.3, 0.3, 0.3));
    y -= 4;
  }

  // Recovery on Arweave — where this data lives such that a customer can
  // re-fetch it directly from the network without involving this verifier
  // or this gateway. Surface the L1 weave offset and (for L2) the data
  // item offset within the parent bundle.
  y -= 12;
  if (y < MARGIN + 80) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y = drawText(page, 'Recovery on Arweave', fontBold, 13, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 8;
  for (const line of recoveryStatement(result.recovery)) {
    if (y < MARGIN + 30) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    const rResult = drawWrappedText(
      page,
      doc,
      line,
      fontRegular,
      8,
      MARGIN,
      y,
      CONTENT_WIDTH,
      12,
      rgb(0.2, 0.2, 0.2)
    );
    page = rResult.page;
    y = rResult.y - 2;
  }

  // Validity window — anchored to EU AI Act Art. 19 (≥6mo retention floor)
  y -= 12;
  if (y < MARGIN + 80) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y = drawText(page, 'Validity', fontBold, 13, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 8;
  const retentionMonths = config.BUNDLE_RETENTION_MONTHS ?? 6;
  const validFrom = new Date(result.timestamp);
  const validUntil = new Date(validFrom);
  validUntil.setMonth(validUntil.getMonth() + retentionMonths);
  const validityLines = [
    `Produced At: ${result.timestamp}`,
    `Valid From:  ${validFrom.toISOString()}`,
    `Valid Until: ${validUntil.toISOString()} (retention policy P${retentionMonths}M, EU AI Act Art. 19 floor)`,
    'Time Source: operator system clock (no RFC 3161 trusted timestamp on this version)',
  ];
  for (const line of validityLines) {
    if (y < MARGIN + 20) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    y = drawText(page, line, fontRegular, 8, MARGIN, y, rgb(0.2, 0.2, 0.2));
    y -= 2;
  }

  // What this report does NOT say — ISAE 3000 §69(k) + EU AI Act Art. 13
  y -= 12;
  if (y < MARGIN + 80) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y = drawText(page, 'What this report does NOT say', fontBold, 13, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 8;
  const limResult = drawWrappedText(
    page,
    doc,
    PDF_LIMITATIONS,
    fontRegular,
    8,
    MARGIN,
    y,
    CONTENT_WIDTH,
    12,
    rgb(0.2, 0.2, 0.2)
  );
  page = limResult.page;
  y = limResult.y;

  // How to re-verify offline — NIST AI RMF MEASURE-2.7 reproducibility
  y -= 12;
  if (y < MARGIN + 80) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y = drawText(page, 'How to re-verify offline', fontBold, 13, MARGIN, y, rgb(0.1, 0.1, 0.1));
  y -= 8;
  const reverifyResult = drawWrappedText(
    page,
    doc,
    PDF_HOW_TO_REVERIFY,
    fontRegular,
    8,
    MARGIN,
    y,
    CONTENT_WIDTH,
    12,
    rgb(0.2, 0.2, 0.2)
  );
  page = reverifyResult.page;
  y = reverifyResult.y;

  // Tags
  if (result.metadata.tags.length > 0) {
    y -= 8;
    if (y < MARGIN + 20) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    y = drawText(page, 'Transaction Tags:', fontBold, 8, MARGIN, y, rgb(0.3, 0.3, 0.3));
    y -= 4;
    for (const tag of result.metadata.tags.slice(0, 20)) {
      if (y < MARGIN + 20) {
        page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
      y = drawText(
        page,
        `  ${tag.name}: ${tag.value}`.substring(0, 100),
        fontRegular,
        7,
        MARGIN,
        y,
        rgb(0.4, 0.4, 0.4)
      );
      y -= 2;
    }
  }

  // Gateway Attestation (only if signed)
  if (result.attestation) {
    y -= 16;
    if (y < MARGIN + 180) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }

    // Divider
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 1,
      color: rgb(0.33, 0.15, 0.78),
    });
    y -= 16;

    y = drawText(page, 'Gateway Attestation', fontBold, 13, MARGIN, y, rgb(0.33, 0.15, 0.78));
    y -= 8;

    const attestText =
      'This certificate is cryptographically signed by a gateway operator on the ar.io network. ' +
      'The signature below proves that the operator attests to the verification results in this document. ' +
      "To verify: compute SHA-256 of the attestation payload and check the RSA-PSS signature against the operator's public key.";
    const aResult = drawWrappedText(
      page,
      doc,
      attestText,
      fontRegular,
      8,
      MARGIN,
      y,
      CONTENT_WIDTH,
      12,
      rgb(0.3, 0.3, 0.3)
    );
    page = aResult.page;
    y = aResult.y;
    y -= 12;

    const att = result.attestation;
    const fields = [
      `Operator: ${att.operator}`,
      `Gateway: ${att.gateway}`,
      `Attested: ${att.attestedAt}`,
      `Payload Hash: ${att.payloadHash}`,
    ];

    for (const line of fields) {
      if (y < MARGIN + 20) {
        page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
      y = drawText(page, line, fontRegular, 7, MARGIN, y, rgb(0.2, 0.2, 0.2));
      y -= 3;
    }

    // Signature — full value, wrapped across lines
    if (y < MARGIN + 60) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    y = drawText(page, 'Signature:', fontRegular, 7, MARGIN, y, rgb(0.2, 0.2, 0.2));
    y -= 2;
    const sigResult = drawWrappedText(
      page,
      doc,
      att.signature,
      fontRegular,
      6,
      MARGIN,
      y,
      CONTENT_WIDTH,
      8,
      rgb(0.3, 0.3, 0.3)
    );
    page = sigResult.page;
    y = sigResult.y;
    y -= 6;

    // Attestation payload — full canonical JSON for independent verification
    if (y < MARGIN + 60) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    y = drawText(
      page,
      'Attestation Payload (canonical JSON):',
      fontRegular,
      7,
      MARGIN,
      y,
      rgb(0.2, 0.2, 0.2)
    );
    y -= 2;
    const payloadJson = JSON.stringify(
      att.payload,
      Object.keys(att.payload as Record<string, unknown>).sort()
    );
    const pResult = drawWrappedText(
      page,
      doc,
      payloadJson,
      fontRegular,
      5,
      MARGIN,
      y,
      CONTENT_WIDTH,
      7,
      rgb(0.35, 0.35, 0.35)
    );
    page = pResult.page;
    y = pResult.y;
  }

  // Conformance footer — single line at the bottom, naming the standards
  // this certificate claims structural alignment with. Stable across PDFs.
  y -= 14;
  if (y < MARGIN + 30) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 10;
  const conformanceLine =
    `Conformance: ${BUNDLE_CONFORMANCE.join(' · ')} · ` +
    `Canonicalization: ${CANONICALIZATION_SPEC} · ` +
    `Signature: RSA-PSS-SHA256 · Verify Server: v${SERVER_VERSION}`;
  drawWrappedText(
    page,
    doc,
    conformanceLine,
    fontRegular,
    6,
    MARGIN,
    y,
    CONTENT_WIDTH,
    8,
    rgb(0.4, 0.4, 0.4)
  );

  return doc.save();
}

function buildEvidenceRows(result: VerificationResult): string[][] {
  const rows: string[][] = [];

  // Existence
  const existStatus =
    result.existence.status === 'confirmed'
      ? 'PASS'
      : result.existence.status === 'pending'
        ? 'PENDING'
        : 'FAIL';
  const existDetail = result.existence.blockHeight
    ? `Block ${result.existence.blockHeight}, ${result.existence.blockTimestamp ?? 'unknown'}`
    : result.existence.status;
  rows.push(['Transaction exists', existStatus, existDetail]);

  // Authenticity (unified)
  if (result.authenticity.status === 'signature_verified') {
    rows.push(['Data authenticity', 'VERIFIED', 'RSA-PSS signature matches deep hash']);
  } else if (result.authenticity.status === 'hash_verified') {
    rows.push(['Data authenticity', 'HASH ONLY', 'SHA-256 fingerprint confirmed']);
  } else {
    rows.push(['Data authenticity', 'UNVERIFIED', 'Signature and hash unavailable']);
  }

  // Owner
  if (result.owner.addressVerified === true) {
    rows.push([
      'Owner address',
      'VERIFIED',
      `SHA-256(pubkey) == ${result.owner.address?.substring(0, 16)}...`,
    ]);
  } else if (result.owner.address) {
    rows.push(['Owner address', 'PRESENT', `${result.owner.address.substring(0, 20)}...`]);
  }

  // Hash fingerprint
  if (result.authenticity.dataHash) {
    rows.push([
      'SHA-256 fingerprint',
      'COMPUTED',
      `${result.authenticity.dataHash.substring(0, 28)}...`,
    ]);
  }

  // Gateway signals (only when our checks are incomplete)
  if (result.authenticity.status !== 'signature_verified') {
    if (result.gatewayAssessment.trusted === true) {
      rows.push(['Trusted source', 'YES', 'Data from trusted source']);
    }
  }

  // Bundle
  if (result.bundle.isBundled) {
    rows.push([
      'Bundle anchored',
      'PASS',
      `Root TX: ${result.bundle.rootTransactionId?.substring(0, 16) ?? 'N/A'}...`,
    ]);
  }

  return rows;
}

// Drawing helpers (unchanged)
function drawText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  x: number,
  y: number,
  color: ReturnType<typeof rgb>
): number {
  page.drawText(text, { x, y, size, font, color });
  return y - size - 2;
}

function drawWrappedText(
  page: PDFPage,
  doc: PDFDocument,
  text: string,
  font: PDFFont,
  size: number,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  color: ReturnType<typeof rgb>
): { page: PDFPage; y: number } {
  const words = text.split(' ');
  let line = '';
  let cp = page;
  let cy = y;

  function flush() {
    if (!line) return;
    cp.drawText(line, { x, y: cy, size, font, color });
    cy -= lineHeight;
    if (cy < MARGIN + 20) {
      cp = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      cy = PAGE_HEIGHT - MARGIN;
    }
    line = '';
  }

  for (const word of words) {
    // Break long words (e.g. base64 signatures, JSON) that exceed maxWidth
    let remaining = word;
    while (remaining) {
      const candidate = line ? `${line} ${remaining}` : remaining;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        remaining = '';
      } else if (line) {
        // Current line is full — flush it, then retry the word on a new line
        flush();
      } else {
        // Single word exceeds maxWidth — break it character by character
        let fit = '';
        for (const ch of remaining) {
          const next = fit + ch;
          if (font.widthOfTextAtSize(next, size) > maxWidth && fit) {
            line = fit;
            flush();
            fit = ch;
          } else {
            fit = next;
          }
        }
        line = fit;
        remaining = '';
      }
    }
  }
  flush();
  return { page: cp, y: cy };
}

function drawTableRow(
  page: PDFPage,
  font: PDFFont,
  size: number,
  startX: number,
  y: number,
  cells: string[],
  colWidths: number[],
  bgColor: ReturnType<typeof rgb> | null
): number {
  const rh = 18;
  if (bgColor) {
    page.drawRectangle({
      x: startX,
      y: y - rh + 4,
      width: colWidths.reduce((a, b) => a + b, 0),
      height: rh,
      color: bgColor,
    });
  }
  let x = startX;
  for (let i = 0; i < cells.length; i++) {
    page.drawText(cells[i].substring(0, Math.floor(colWidths[i] / (size * 0.5))), {
      x: x + 4,
      y: y - rh + 8,
      size,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
    x += colWidths[i];
  }
  return y - rh;
}
