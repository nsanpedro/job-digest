'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { signOutAction } from '@/lib/actions';
import styles from './Chrome.module.css';

export type Tab = 'digest' | 'saved' | 'applications' | 'dismissed' | 'unread' | 'profile';

/**
 * Self-detects the active tab from the URL rather than taking it as a prop —
 * what lets this render once in a shared layout (design: perf pass, Aug
 * 2026) instead of every page repeating the same `active="…"` literal. A
 * client component specifically for this: usePathname() has no server-side
 * equivalent that a shared layout could call once and hand down, and the nav
 * itself has no data dependency that would cost anything by living here.
 */
function useActiveTab(): Tab | null {
  const pathname = usePathname();
  const segment = pathname.split('/')[1];
  const tabs: Tab[] = ['digest', 'saved', 'applications', 'dismissed', 'unread', 'profile'];
  return (tabs as string[]).includes(segment ?? '') ? (segment as Tab) : null;
}

export function TopBar({
  unreadCount,
  savedCount,
  applicationCount = 0,
  userEmail,
}: {
  unreadCount: number;
  savedCount: number;
  /** Open applications — the ones still waiting on an answer. */
  applicationCount?: number;
  userEmail: string;
}) {
  const active = useActiveTab();
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
            href="/applications"
            className={`${styles.tab} ${active === 'applications' ? styles.tabActive : ''}`}
          >
            Applications
            {applicationCount > 0 && (
              <span className={`${styles.badge} ${styles.badgeNeutral}`}>{applicationCount}</span>
            )}
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
            <form action={signOutAction}>
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
