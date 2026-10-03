'use client';

import { useState } from 'react';
import type { Ruleset } from '@job-digest/core';
import type { Digest, DigestAd } from '@job-digest/db';
import { DismissableAdList } from './DismissableAdList';
import { useDismissFollowUps, type DismissFollowUps } from './dismiss-follow-ups';
import { EmptyDigestDiagnostic } from './EmptyDigestDiagnostic';
import { FilteredSection } from './FilteredSection';
import { placementOf } from './override-follow-ups';
import styles from './DigestList.module.css';

/**
 * How many explore entries to promote as "Worth a look" cards, rendered
 * expanded alongside the main matches. The remaining explore entries fall
 * into the collapsed "Hidden" disclosure below.
 *
 * Rule: top-N by score. Explore is already sorted by `compareAds` in
 * `packages/db/src/queries/digest.ts` (score desc first, then rule-outcome
 * quality, then recency), so `slice(0, N)` picks the N strongest that just
 * missed the tier threshold. N = 3 keeps the promoted slice small — the
 * point is to surface a couple of near-misses that a test PM user would
 * otherwise never see because they lived behind an obscure link, not to
 * restart the digest with a second batch of full-weight cards.
 */
const WORTH_A_LOOK_TOP_N = 3;

function matchCountLine(n: number): string {
  if (n === 0) return 'No matches this week.';
  if (n === 1) return '1 match this week.';
  if (n <= 3) return `${n} matches this week — all worth your time.`;
  return `${n} matches this week.`;
}

/**
 * The "Worth a look" and "Hidden" sections. Rendered whenever the explore
 * bucket has entries — in both the has-matches and empty-diagnostic paths.
 * Design decision: even when the four curated tiers are empty, showing the
 * near-misses is the whole point of this change; the PM test user who saw a
 * blank digest and concluded "nothing this week" would otherwise still see a
 * blank page next to a paragraph explaining the count. Keeping them visible
 * in the empty path means the diagnostic and the near-misses coexist.
 *
 * Single source of truth: consumes `digest.explore` already loaded on the
 * page. No second query. The split between "Worth a look" (top N) and
 * "Hidden" (rest) is a pure in-memory slice.
 */
function ExplorePromoted({
  explore,
  followUps,
  expandedId,
  onToggle,
}: {
  explore: DigestAd[];
  followUps: DismissFollowUps;
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  // A follow-up row keeps its section on screen after the server moved its
  // ad out — including when that emptied the section.
  const worthALook = explore.slice(0, WORTH_A_LOOK_TOP_N);
  const hidden = explore.slice(WORTH_A_LOOK_TOP_N);
  const showWorth = worthALook.length > 0 || followUps.has('worth');
  const showHidden = hidden.length > 0 || followUps.has('hidden');

  return (
    <>
      {showWorth && (
        <section className={styles.worthALook}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionLabel}>Worth a look</h2>
            <span className={styles.sectionGloss}>close to the bar, not over it</span>
            <span className={`mesh-rule ${styles.sectionRule}`} />
          </div>
          <DismissableAdList
            list="worth"
            ads={worthALook}
            followUps={followUps}
            expandedId={expandedId}
            onToggle={onToggle}
            className={styles.adList}
          />
        </section>
      )}

      {showHidden && (
        // Native <details>/<summary>: the count stays visible when collapsed
        // (the whole reason for keeping it visible without weight), and no
        // React state is needed for a disclosure this simple. The AdCards
        // inside still manage their own accordion state via the outer
        // `expandedId` — opening a hidden card closes any other card,
        // including one in the top matches or the worth-a-look slice.
        <details className={styles.hidden} id="hidden">
          <summary>
            Hidden — {hidden.length} more filtered out
          </summary>
          <div className={styles.hiddenList}>
            <DismissableAdList
              list="hidden"
              ads={hidden}
              followUps={followUps}
              expandedId={expandedId}
              onToggle={onToggle}
              className={styles.adList}
            />
          </div>
        </details>
      )}
    </>
  );
}

/**
 * Owns the single-expand accordion state across all sections — opening one
 * card closes any other — and the dismiss follow-up rows of every section
 * (see useDismissFollowUps: a section the server empties keeps its rows).
 */
export function DigestList({ digest, rules }: { digest: Digest; rules: Ruleset }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggle = (id: string) => setExpandedId((cur) => (cur === id ? null : id));
  const followUps = useDismissFollowUps();

  // Merge all curated tiers into a single flat list sorted by score desc.
  const matches: DigestAd[] = [
    ...digest.topPicks,
    ...digest.worthAReading,
    ...digest.stretch,
    ...digest.stillOpen,
  ].sort((a, b) => (b.scoreBreakdown?.total ?? 0) - (a.scoreBreakdown?.total ?? 0));
  const empty = matches.length === 0;

  // "Show anyway" (ADR-003 §8.14): the held section asks where the ad
  // landed, and "Go to it" opens its card — unfolding "Hidden" first when
  // that is where it went.
  const placement = (adId: string) => placementOf(adId, matches, digest.explore, WORTH_A_LOOK_TOP_N);
  const reveal = (adId: string) => {
    if (placement(adId) === 'hidden') {
      const hidden = document.getElementById('hidden');
      if (hidden instanceof HTMLDetailsElement) hidden.open = true;
    }
    setExpandedId(adId);
    requestAnimationFrame(() =>
      document.getElementById(`ad-${adId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    );
  };
  const filtered = (
    <FilteredSection
      dismissed={digest.dismissed}
      rules={rules}
      rulesetVersion={digest.rulesetVersion}
      placementOf={placement}
      onReveal={reveal}
    />
  );

  // The empty case has two flavors — nothing at all, and "we saw ads but none
  // tiered". Both used to collapse to a single line ("No matches this week." /
  // "No ads arrived in this window."), which read the same to a test PM user
  // as "nothing happened this week" and hid the mechanism (parse failures,
  // below-threshold misses, everything blocked by rules). The diagnostic
  // narrates the counts the digest already carries — see EmptyDigestDiagnostic.
  //
  // One tree for both layouts, so switching between them (the last curated
  // ad dismissed, or its Undo) keeps every element in place: the curated
  // list stays mounted and, in the empty layout, still shows the follow-up
  // row of the ad just dismissed — above the diagnostic, where the card was.
  return (
    <div className={styles.root}>
      {!empty && <p className={styles.matchCount}>{matchCountLine(matches.length)}</p>}

      <DismissableAdList
        list="curated"
        ads={matches}
        followUps={followUps}
        expandedId={expandedId}
        onToggle={toggle}
        className={styles.adList}
      />

      {empty && <EmptyDigestDiagnostic digest={digest} rules={rules} />}

      {/*
        Even with zero curated matches, promote the top of explore inline —
        this is the whole fix for the PM test user who saw "nothing this week"
        without realising an explore bucket existed at all. The diagnostic
        still explains the count above; these are the concrete near-misses.
      */}
      <ExplorePromoted explore={digest.explore} followUps={followUps} expandedId={expandedId} onToggle={toggle} />

      {filtered}
    </div>
  );
}
