import { SkeletonBar } from '@/components/Skeleton';
import styles from '@/components/Skeleton.module.css';

export default function ProfileLoading() {
  return (
    <div className="container">
      <SkeletonBar width={140} height={27} style={{ margin: '32px 0 24px' }} />
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className={styles.card} style={{ marginBottom: 20 }}>
          <SkeletonBar width="30%" height={16} style={{ marginBottom: 14 }} />
          <SkeletonBar width="90%" height={13} style={{ marginBottom: 8 }} />
          <SkeletonBar width="60%" height={13} />
        </div>
      ))}
    </div>
  );
}
