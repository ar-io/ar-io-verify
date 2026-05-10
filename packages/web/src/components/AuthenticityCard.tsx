import type { VerificationResult } from '../api/client';
import CopyHash from './CopyHash';

interface Props {
  authenticity: VerificationResult['authenticity'];
  owner: VerificationResult['owner'];
}

export default function AuthenticityCard({ authenticity, owner }: Props) {
  return (
    <div className="rounded-2xl border border-ario-border bg-ario-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md md:col-span-2">
      <h3 className="mb-4 text-sm font-medium text-ario-black/50">Is this data authentic?</h3>

      {authenticity.status === 'signature_verified' ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xl text-green-600">&#10003;</span>
            <div>
              <p className="font-semibold text-green-700">Digital signature verified</p>
              <p className="text-xs text-green-600">
                This data is exactly what the owner signed. It has not been modified.
              </p>
            </div>
          </div>

          {owner.address && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ario-black/40">Signed by</span>
              <CopyHash
                value={owner.address}
                href={`https://viewblock.io/arweave/address/${owner.address}`}
              />
            </div>
          )}

          {authenticity.dataHash && (
            <details className="text-xs">
              <summary className="cursor-pointer text-ario-black/30 hover:text-ario-black/50">
                Technical details
              </summary>
              <div className="mt-2 space-y-1 rounded-lg bg-white p-2 text-ario-black/40">
                <p>
                  Data fingerprint: <span className="font-mono">{authenticity.dataHash}</span>
                </p>
                {owner.addressVerified && <p>Address derived from public key (SHA-256)</p>}
                <p>Verification: RSA-PSS digital signature</p>
              </div>
            </details>
          )}
        </div>
      ) : authenticity.status === 'hash_verified' ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xl text-ario-primary">&#10003;</span>
            <div>
              <p className="font-semibold text-ario-primary">Data fingerprint confirmed</p>
              <p className="text-xs text-ario-primary/70">
                The data fingerprint was independently computed. Signature could not be checked.
              </p>
            </div>
          </div>

          {authenticity.signatureSkipReason && (
            <p className="text-xs text-ario-black/40">{authenticity.signatureSkipReason}</p>
          )}

          {owner.address && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ario-black/40">Owner</span>
              <CopyHash
                value={owner.address}
                href={`https://viewblock.io/arweave/address/${owner.address}`}
              />
            </div>
          )}

          {authenticity.dataHash && (
            <p className="font-mono text-xs text-ario-black/30">{authenticity.dataHash}</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xl text-ario-black/30">&#9675;</span>
            <div>
              <p className="font-semibold text-ario-black/60">Not yet verified</p>
              <p className="text-xs text-ario-black/40">
                {authenticity.signatureSkipReason?.includes('too large')
                  ? authenticity.signatureSkipReason
                  : 'The gateway is still indexing this data. Try re-verifying in a moment.'}
              </p>
            </div>
          </div>

          {owner.address && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ario-black/40">Reported owner</span>
              <CopyHash value={owner.address} />
            </div>
          )}
        </div>
      )}

      {owner.publicKey && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-ario-black/30 hover:text-ario-black/50">
            Public key
          </summary>
          <p className="mt-1 break-all rounded-lg bg-white p-2 font-mono text-[10px] leading-relaxed text-ario-black/40">
            {owner.publicKey}
          </p>
        </details>
      )}
    </div>
  );
}
