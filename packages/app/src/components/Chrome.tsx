import Link from 'next/link';
import { signOut } from '@/auth';
import styles from './Chrome.module.css';

export type Tab = 'digest' | 'saved' | 'dismissed' | 'unread' | 'profile';

export function TopBar({
  active,
  unreadCount,
  savedCount,
  userEmail,
}: {
  active: Tab;
  unreadCount: number;
  savedCount: number;
  userEmail: string;
}) {
  const initial = userEmail.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="container">
      <div className={styles.bar}>
        <div className={styles.brand}>
          <span className={styles.logo}>J</span>
          <span className={styles.brandLabel}>Job alert digest · Hamburg</span>
        </div>
        <nav className={styles.tabs}>
          <Link href="/digest" className={`${styles.tab} ${active === 'digest' ? styles.tabActive : ''}`}>
            Weekly digest
          </Link>
          <Link href="/saved" className={`${styles.tab} ${active === 'saved' ? styles.tabActive : ''}`}>
            Saved
            {savedCount > 0 && <span className={`${styles.badge} ${styles.badgeNeutral}`}>{savedCount}</span>}
          </Link>
          <Link
            href="/dismissed"
            className={`${styles.tab} ${active === 'dismissed' ? styles.tabActive : ''}`}
          >
            Dismissed
          </Link>
          <Link href="/unread" className={`${styles.tab} ${active === 'unread' ? styles.tabActive : ''}`}>
            Emails we couldn't read
            {unreadCount > 0 && <span className={styles.badge}>{unreadCount}</span>}
          </Link>
        </nav>
        <div className={styles.right}>
          <div className={styles.userMenu}>
            <Link
              href="/profile"
              className={`${styles.avatar} ${active === 'profile' ? styles.avatarActive : ''}`}
              title={userEmail}
            >
              {initial}
            </Link>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/login' });
              }}
            >
              <button type="submit" className={styles.signOut}>
                Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
