import Link from 'next/link';
import { SiftLogo } from './SiftLogo';
import { SiftWordmark } from './SiftWordmark';
import styles from './Footer.module.css';

/**
 * App-wide footer — brand + tagline on the left, secondary navigation on
 * the right. The secondary nav is where routes that don't live in the
 * top bar's three-tab strip (Saved, Applications, Dismissed) surface,
 * so nothing is orphaned by the redesign's tighter primary nav.
 */
export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <SiftLogo size={32} />
          <div>
            <SiftWordmark size={15} />
            <p className={styles.tagline}>Only the jobs worth reading, sifted from your inbox.</p>
          </div>
        </div>
        <nav className={styles.nav}>
          <Link href="/saved" className={styles.link}>
            Saved
          </Link>
          <Link href="/applications" className={styles.link}>
            Applications
          </Link>
          <Link href="/dismissed" className={styles.link}>
            Dismissed
          </Link>
          <Link href="/unread" className={styles.link}>
            Unread
          </Link>
          <Link href="/profile" className={styles.link}>
            The sift
          </Link>
        </nav>
      </div>
    </footer>
  );
}
