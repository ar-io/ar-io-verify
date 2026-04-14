import { useState, useEffect } from 'react';
import { getRuntimeConfig } from '../api/client';

interface Props {
  txId: string;
  contentType: string | null;
}

export default function DataPreview({ txId, contentType }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);

  useEffect(() => {
    getRuntimeConfig().then((c) => setGatewayUrl(c.publicGatewayUrl));
  }, []);

  if (!contentType || !contentType.startsWith('image/') || loadError || !gatewayUrl) return null;

  const imgSrc = `${gatewayUrl.replace(/\/$/, '')}/raw/${txId}`;

  return (
    <div className="rounded-2xl border border-ario-border bg-ario-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
      <h3 className="mb-3 text-sm font-medium text-ario-black/50">Data preview</h3>
      <div
        className={`overflow-hidden rounded-xl bg-white transition-all duration-300 ${
          expanded ? 'max-h-[600px]' : 'max-h-48'
        }`}
      >
        <img
          src={imgSrc}
          alt={`Verified data: ${txId.substring(0, 8)}...`}
          className="h-full w-full cursor-pointer object-contain"
          onClick={() => setExpanded(!expanded)}
          onError={() => setLoadError(true)}
        />
      </div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-xs text-ario-primary hover:underline"
      >
        {expanded ? 'Collapse' : 'Expand preview'}
      </button>
    </div>
  );
}
