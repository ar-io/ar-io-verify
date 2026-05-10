import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { verifyTransaction } from '../api/client';
import ProgressIndicator from '../components/ProgressIndicator';

const EXAMPLES = [
  { txId: 'WkaBoAfqfW2P4K2NO1SBDwhVsKQJSVTVEnaDvjoyZzA', label: 'PDF', icon: '\uD83D\uDCC4' },
  {
    txId: '0T8mUqgnSnVY2hdUA8FV3uaWPe1QUcgcOiqdsDWCQII',
    label: 'JPEG',
    icon: '\uD83D\uDDBC\uFE0F',
  },
  { txId: 'Yh10aRkLW0s5yJX4X6-DO1T6JYkLtslWBIOHAFziSzs', label: 'PNG', icon: '\uD83C\uDFA8' },
  { txId: 'mltyfIZ-mD3Lc50Y_QfdaJ7SM6aBKquG0ORfQ3dEb0Q', label: 'Video', icon: '\uD83C\uDFAC' },
];

const FEATURES = [
  { icon: '\uD83D\uDD12', label: 'Signature verification' },
  { icon: '\uD83D\uDD17', label: 'Data integrity check' },
  { icon: '\uD83D\uDCC4', label: 'PDF certificate' },
];

export default function VerifyInput() {
  const [txId, setTxId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Deep-link: ?tx=xxx auto-verifies on load
  useEffect(() => {
    const txParam = searchParams.get('tx');
    if (txParam && /^[a-zA-Z0-9_-]{43}$/.test(txParam)) {
      setTxId(txParam);
      doVerify(txParam);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doVerify = async (id: string) => {
    setLoading(true);
    setError(null);
    setElapsed(0);

    const start = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);

    try {
      const result = await verifyTransaction(id);
      navigate(`/report/${result.verificationId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('fetch') ||
        msg.includes('network') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('Failed')
      ) {
        setError(
          'The verification service is temporarily unavailable. Please try again in a moment.'
        );
      } else {
        setError(msg || 'Verification failed');
      }
      setLoading(false);
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const handleVerify = () => {
    const trimmed = txId.trim();
    if (!trimmed) {
      setError('Please enter a transaction ID');
      return;
    }
    if (!/^[a-zA-Z0-9_-]{43}$/.test(trimmed)) {
      setError('Invalid transaction ID format (expected 43 base64url characters)');
      return;
    }
    doVerify(trimmed);
  };

  const handleExample = (id: string) => {
    setTxId(id);
    doVerify(id);
  };

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col">
      {/* Hero */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="font-heading text-4xl font-extrabold tracking-tight text-ario-black sm:text-5xl">
            Verify any data on Arweave
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-lg text-ario-black/60">
            Cryptographic proof of existence, integrity, and authorship. Independently verified by
            your ar.io gateway.
          </p>
        </div>

        {/* Input card */}
        <div className="mt-8 w-full max-w-xl">
          <div className="rounded-2xl border border-ario-border bg-ario-card p-6 shadow-sm">
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="txId"
                  className="mb-1.5 block text-sm font-medium text-ario-black/70"
                >
                  Transaction ID
                </label>
                <input
                  id="txId"
                  type="text"
                  value={txId}
                  onChange={(e) => setTxId(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !loading && handleVerify()}
                  placeholder="Enter a 43-character Arweave transaction ID"
                  className="w-full rounded-xl border border-ario-border bg-white px-4 py-3 font-mono text-sm focus:border-ario-primary focus:outline-none focus:ring-1 focus:ring-ario-primary"
                  disabled={loading}
                />
              </div>

              {error && (
                <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</div>
              )}

              <button
                onClick={handleVerify}
                disabled={loading}
                className="w-full rounded-full bg-ario-black px-5 py-3 font-semibold text-ario-card transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ario-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Verifying...' : 'Verify'}
              </button>
            </div>

            {loading && (
              <div className="mt-5">
                <ProgressIndicator elapsed={elapsed} />
              </div>
            )}

            {/* Example buttons */}
            {!loading && (
              <div className="mt-5 border-t border-ario-border pt-4">
                <p className="mb-2.5 text-xs font-medium text-ario-black/40">Try an example</p>
                <div className="flex flex-wrap gap-2">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex.txId}
                      onClick={() => handleExample(ex.txId)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-ario-border bg-white/70 px-3 py-1.5 text-xs font-medium text-ario-black/60 transition-colors hover:bg-white hover:text-ario-black"
                    >
                      <span>{ex.icon}</span>
                      {ex.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Feature pills */}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {FEATURES.map((f) => (
            <span
              key={f.label}
              className="inline-flex items-center gap-1.5 rounded-full border border-ario-border bg-white/60 px-3 py-1.5 text-xs font-medium text-ario-black/50"
            >
              <span>{f.icon}</span>
              {f.label}
            </span>
          ))}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-ario-border px-4 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="https://ar.io/brand/ario-black.svg" alt="ar.io" className="h-4 opacity-30" />
            <span className="text-xs text-ario-black/30">Powered by ar.io gateway</span>
          </div>
          <a
            href="https://ar.io"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-ario-primary hover:underline"
          >
            ar.io
          </a>
        </div>
      </footer>
    </div>
  );
}
