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
import { getApplicationCountsCached, getSavedCountCached, getUnreadEmailsCached, getUserCityCached } from '@/lib/nav-data';
import { getIsOnboarded } from '@/lib/onboarding-actions';
import { TopBar } from '@/components/Chrome';
import { Footer } from '@/components/Footer';
import { GmailStatusBanner } from '@/components/GmailStatusBanner';
import { OnboardingModal } from '@/components/OnboardingModal';
import { currentUser } from '@/lib/session';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  // Serial, not Promise.all: this layout renders on every authenticated
  // route, and every branch below opens its own withTenant, so at
  // Promise.all the layout alone holds five Postgres connections per
  // request against an app pool of max: 4 in prod (packages/app/src/lib/db.ts:25) —
  // that overshoot cascades into EMAXCONNSESSION on the shared
  // 15-connection Supabase pooler exactly the way /profile did (see the
  // /profile fix in commit 062d27d for the source incident and the same
  // rationale). Serialised, the layout holds one connection at a time;
  // the latency cost is the sum-vs-max of five small tenant-scoped
  // reads, which the layout is not perf-critical enough to pay for.
  const unread = await getUnreadEmailsCached(user.id);
  const savedCount = await getSavedCountCached(user.id);
  const applications = await getApplicationCountsCached(user.id);
  const isOnboarded = await getIsOnboarded();
  const city = await getUserCityCached(user.id);

  return (
    <>
      <TopBar
        unreadCount={unread.length}
        savedCount={savedCount}
        applicationCount={applications.open}
        userEmail={user.email}
        city={city}
      />
      {!isOnboarded && <OnboardingModal />}
      {/*
        Renders nothing when Gmail is healthy — so this row stays out of
        the way for the common case. Two loud shapes otherwise: amber
        when the user dismissed the connect page for a week, block when
        the connection stopped working (see GmailStatusBanner.tsx).
      */}
      <GmailStatusBanner userId={user.id} />
      {children}
      <Footer />
    </>
  );
}
