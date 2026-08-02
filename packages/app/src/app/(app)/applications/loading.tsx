import { SkeletonAdCardList, SkeletonPageHeader } from '@/components/Skeleton';

export default function ApplicationsLoading() {
  return (
    <div className="container">
      <SkeletonPageHeader />
      <SkeletonAdCardList count={3} />
    </div>
  );
}
