import CopyHash from './CopyHash';

interface Props {
  existence: {
    status: 'confirmed' | 'pending' | 'not_found';
    blockHeight: number | null;
    blockTimestamp: string | null;
  };
  txId: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function ExistenceCard({ existence, txId }: Props) {
  const statusColor =
    existence.status === 'confirmed'
      ? 'text-green-600'
      : existence.status === 'pending'
        ? 'text-ario-primary/70'
        : 'text-red-600';

  const statusIcon =
    existence.status === 'confirmed'
      ? '&#10003;'
      : existence.status === 'pending'
        ? '&#8987;'
        : '&#10007;';

  return (
    <div className="rounded-2xl border border-ario-border bg-ario-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
      <h3 className="mb-3 text-sm font-medium text-ario-black/50">Is this data on Arweave?</h3>
      <div className="flex items-center gap-2">
        <span
          className={`text-3xl ${statusColor}`}
          dangerouslySetInnerHTML={{ __html: statusIcon }}
        />
        <div>
          <p className={`font-semibold ${statusColor}`}>
            {existence.status === 'confirmed'
              ? 'Confirmed'
              : existence.status === 'pending'
                ? 'Pending'
                : 'Not Found'}
          </p>
          {existence.blockHeight && (
            <a
              href={`https://viewblock.io/arweave/block/${existence.blockHeight}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-ario-primary hover:underline"
            >
              Block {existence.blockHeight.toLocaleString()}
            </a>
          )}
        </div>
      </div>
      {existence.blockTimestamp && (
        <p className="mt-2 text-xs text-ario-black/50">
          {new Date(existence.blockTimestamp).toUTCString()}
          <span className="ml-1 text-ario-black/30">
            ({relativeTime(existence.blockTimestamp)})
          </span>
        </p>
      )}
      <div className="mt-2 text-xs">
        <CopyHash value={txId} href={`https://viewblock.io/arweave/tx/${txId}`} />
      </div>
    </div>
  );
}
