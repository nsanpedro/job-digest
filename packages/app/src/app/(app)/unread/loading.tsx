import { SkeletonAdCardList, SkeletonPageHeader } from '@/components/Skeleton';

export default function UnreadLoading() {
  return (
    <div className="container">
      <SkeletonPageHeader />
      <SkeletonAdCardList count={4} />
    </div>
  );
}
