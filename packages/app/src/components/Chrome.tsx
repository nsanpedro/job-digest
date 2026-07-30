import Link from 'next/link';
import styles from './Chrome.module.css';

export function TopBar({
  active,
  unreadCount,
}: {
  active: 'digest' | 'unread';
  unreadCount: number;
}) {
  return (
    <div className="container">
      <div className={styles.bar}>
        <div className={styles.brand}>
          <span className={styles.logo}>J</span>
          <span className={styles.brandLabel}>Job alert digest · Hamburg</span>
        </div>
        <nav className={styles.tabs}>
          <Link
            href="/digest"
            className={`${styles.tab} ${active === 'digest' ? styles.tabActive : ''}`}
          >
            Weekly digest
          </Link>
          <Link
            href="/unread"
            className={`${styles.tab} ${active === 'unread' ? styles.tabActive : ''}`}
          >
            Emails we couldn't read
            {unreadCount > 0 && <span className={styles.badge}>{unreadCount}</span>}
          </Link>
        </nav>
      </div>
    </div>
  );
}
