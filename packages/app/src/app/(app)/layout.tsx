/**
 * Shared chrome for every authenticated page (design: perf pass, Aug 2026).
 *
 * TopBar used to be rendered inside each page.tsx, which meant it unmounted
 * and remounted on every navigation — nav bar included — while the whole
 * new page's data loaded. Rendered here instead, it stays mounted across
 * navigations between routes in this group; only the part below it suspends
 * (each route's loading.tsx) while its own data streams in. This is what
 * makes tab-switching read as "the page updates" rather than "the app
 * reloads".
 */
import { getApplicationCountsCached, getSavedCountCached, getUnreadEmailsCached } from '@/lib/nav-data';
import { getIsOnboarded } from '@/lib/onboarding-actions';
import { TopBar } from '@/components/Chrome';
import { OnboardingModal } from '@/components/OnboardingModal';
import { currentUser } from '@/lib/session';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const [unread, savedCount, applications, isOnboarded] = await Promise.all([
    getUnreadEmailsCached(user.id),
    getSavedCountCached(user.id),
    getApplicationCountsCached(user.id),
    getIsOnboarded(),
  ]);

  return (
    <>
      <TopBar
        unreadCount={unread.length}
        savedCount={savedCount}
        applicationCount={applications.open}
        userEmail={user.email}
      />
      {!isOnboarded && <OnboardingModal />}
      {children}
    </>
  );
}
