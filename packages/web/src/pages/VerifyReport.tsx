import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getVerification, verifyTransaction, type VerificationResult } from '../api/client';
import VerificationHero from '../components/VerificationHero';
import ProvenanceChain from '../components/ProvenanceChain';
import ExistenceCard from '../components/ExistenceCard';
import AuthenticityCard from '../components/AuthenticityCard';
import MetadataCard from '../components/MetadataCard';
import BundleCard from '../components/BundleCard';
import GatewayAssessmentCard from '../components/GatewayAssessmentCard';
import DataPreview from '../components/DataPreview';
import FileCompare from '../components/FileCompare';

export default function VerifyReport() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reverifying, setReverifying] = useState(false);

  useEffect(() => {
    if (!id) return;
    getVerification(id)
      .then(setResult)
      .catch((err) => setError(err.message));
  }, [id]);

  const handleReverify = async () => {
    if (!result) return;
    setReverifying(true);
    try {
      const fresh = await verifyTransaction(result.txId);
      navigate(`/report/${fresh.verificationId}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-verification failed');
    } finally {
      setReverifying(false);
    }
  };

  const isServiceDown =
    error &&
    (error.includes('fetch') ||
      error.includes('network') ||
      error.includes('502') ||
      error.includes('503') ||
      error.includes('Failed'));

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div
          className={`rounded-2xl border p-8 shadow-sm ${isServiceDown ? 'border-ario-border bg-ario-lavender/30' : 'border-red-200 bg-red-50'}`}
        >
          <h2
            className={`font-heading text-lg font-extrabold tracking-tight ${isServiceDown ? 'text-ario-black/70' : 'text-red-800'}`}
          >
            {isServiceDown ? 'Service Unavailable' : 'Verification Not Found'}
          </h2>
          <p className={`mt-2 ${isServiceDown ? 'text-ario-black/50' : 'text-red-700'}`}>
            {isServiceDown
              ? 'The verification service is temporarily unavailable. Please try again in a moment.'
              : error}
          </p>
          <div className="mt-4 flex gap-3">
            {isServiceDown && (
              <button
                onClick={() => {
                  setError(null);
                  window.location.reload();
                }}
                className="rounded-full bg-ario-black px-4 py-2 text-xs font-semibold text-ario-card transition-opacity hover:opacity-90"
              >
                Retry
              </button>
            )}
            <Link
              to="/"
              className="rounded-full border border-ario-border bg-white/70 px-4 py-2 text-xs font-semibold text-ario-black transition-colors hover:bg-white"
            >
              Verify another transaction
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-ario-primary border-t-transparent" />
      </div>
    );
  }

  const hasImage = result.metadata.contentType?.startsWith('image/');
  const dataHash = result.authenticity.dataHash;
  const checksPass = result.authenticity.status === 'signature_verified';

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      {/* 1. Hero: verdict + actions + pills */}
      <VerificationHero result={result} onReverify={handleReverify} reverifying={reverifying} />

      {/* 2. Provenance chain */}
      <ProvenanceChain result={result} />

      {/* 3. Proof */}
      <section>
        <h3 className="mb-4 font-heading text-base font-extrabold tracking-tight text-ario-black/70">
          Proof
        </h3>
        <div className="grid gap-4 md:grid-cols-2">
          <AuthenticityCard authenticity={result.authenticity} owner={result.owner} />
          <ExistenceCard existence={result.existence} txId={result.txId} />
          {result.bundle.isBundled && <BundleCard bundle={result.bundle} />}
        </div>
      </section>

      {/* 4. Preview & compare */}
      {(hasImage || dataHash) && (
        <section>
          <h3 className="mb-4 font-heading text-base font-extrabold tracking-tight text-ario-black/70">
            {hasImage ? 'Preview & compare' : 'Compare local file'}
          </h3>
          <div className={`grid gap-4 ${hasImage && dataHash ? 'md:grid-cols-2' : ''}`}>
            {hasImage && (
              <DataPreview txId={result.txId} contentType={result.metadata.contentType} />
            )}
            {dataHash && <FileCompare integrityHash={dataHash} />}
          </div>
        </section>
      )}

      {/* 5. Details */}
      <section>
        <h3 className="mb-4 font-heading text-base font-extrabold tracking-tight text-ario-black/70">
          Details
        </h3>
        <div className="grid gap-4 md:grid-cols-2">
          <MetadataCard metadata={result.metadata} />
          <GatewayAssessmentCard assessment={result.gatewayAssessment} checksPass={checksPass} />
        </div>
      </section>

      {/* 6. Footer */}
      <footer className="flex items-center justify-between border-t border-ario-border pt-4">
        <div className="flex items-center gap-2">
          <img src="https://ar.io/brand/ario-black.svg" alt="ar.io" className="h-4 opacity-30" />
          <span className="text-xs text-ario-black/30">
            Verified by ar.io gateway &middot; {result.verificationId}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <a
            href={`https://viewblock.io/arweave/tx/${result.txId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-ario-primary hover:underline"
          >
            View on Viewblock
          </a>
          <Link to="/" className="text-xs text-ario-black/40 hover:text-ario-black/60">
            Verify another
          </Link>
        </div>
      </footer>
    </div>
  );
}
