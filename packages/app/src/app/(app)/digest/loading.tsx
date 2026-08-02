import { SkeletonAdCardList, SkeletonBar } from '@/components/Skeleton';

export default function DigestLoading() {
  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 32, padding: '32px 0 24px', flexWrap: 'wrap' }}>
        <div>
          <SkeletonBar width={280} height={27} />
          <SkeletonBar width={340} height={13} style={{ marginTop: 10 }} />
        </div>
        <SkeletonBar width={140} height={38} style={{ borderRadius: 'var(--radius-btn)' }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, marginBottom: 20 }}>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: 16 }}>
            <SkeletonBar width={80} height={10} />
            <SkeletonBar width={40} height={30} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>

      <SkeletonAdCardList count={5} />
    </div>
  );
}
