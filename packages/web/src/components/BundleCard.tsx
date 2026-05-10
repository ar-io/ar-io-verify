import CopyHash from './CopyHash';

interface Props {
  bundle: {
    isBundled: boolean;
    rootTransactionId: string | null;
  };
}

export default function BundleCard({ bundle }: Props) {
  if (!bundle.isBundled) return null;

  return (
    <div className="rounded-2xl border border-ario-border bg-ario-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
      <h3 className="mb-3 text-sm font-medium text-ario-black/50">Bundle</h3>
      <p className="text-sm text-ario-black/70">
        This is an ANS-104 bundled data item. Its signature and integrity are verified independently
        from the bundle. The bundle anchors it to the blockchain.
      </p>
      {bundle.rootTransactionId && (
        <div className="mt-2 text-xs">
          <CopyHash
            value={bundle.rootTransactionId}
            label="Root TX:"
            href={`https://viewblock.io/arweave/tx/${bundle.rootTransactionId}`}
          />
        </div>
      )}
    </div>
  );
}
