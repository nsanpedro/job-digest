'use server';

/**
 * Dismiss reasons as explicit feedback (ADR-003 §8.11). Its own file, like
 * discovery-actions.ts, rather than more exports in actions.ts.
 *
 * Deliberately thin: what a reason does is decided by `planDismissFeedback`
 * and `suggestExcludeTerms` in @job-digest/core (pure, tested); these
 * actions load their inputs, persist the outcome and revalidate. Dismiss
 * itself stays the one-click `dismissAd` in actions.ts — a reason is an
 * optional follow-up, never a step in front of it.
 */
import { revalidatePath } from 'next/cache';
import {
  companyKey,
  deriveCandidateProfile,
  effectKindOwnedBy,
  isDismissReason,
  planDismissFeedback,
  suggestExcludeTerms,
  type DismissFeedback,
  type DismissReason,
} from '@job-digest/core';
import {
  addExcludeFromDismissal,
  getActiveProfile,
  listInterestedDirections,
  muteCompany,
  recordDismissReason,
  removeEffectsFromAd,
  removeFeedbackEffect,
  unmuteCompany as dbUnmuteCompany,
} from '@job-digest/db';
import { currentUserId, withTenant } from './session';

function revalidateFeedback() {
  revalidatePath('/digest');
  revalidatePath('/digest/explore');
  revalidatePath('/dismissed');
  revalidatePath('/profile');
}

/**
 * Records why an ad was dismissed and applies the reason's effect: a mute
 * is saved here; an exclude is only proposed (the user confirms it with
 * `acceptExcludeSuggestion`). Picking a different reason undoes the
 * previous reason's effect for this ad (`effectKindOwnedBy`). Also the
 * dismiss itself when the reason comes from the card's "Dismiss because"
 * strip: `recordDismissReason` dismisses an ad that is not dismissed yet.
 */
export async function setDismissReason(adId: string, reason: DismissReason): Promise<DismissFeedback> {
  if (!isDismissReason(reason)) throw new Error(`unknown dismiss reason: ${String(reason)}`);
  const userId = await currentUserId();
  const outcome = await withTenant(userId, async (tx) => {
    const ad = await recordDismissReason(tx, userId, adId, reason);
    if (!ad) return { kind: 'noted' } as const;
    const directions = await listInterestedDirections(tx, userId);
    const profile = await getActiveProfile(tx, userId);
    const candidate = deriveCandidateProfile({ skills: profile?.skills ?? [], directions });
    const plan = planDismissFeedback({ reason, ad, directions, candidate });

    await removeEffectsFromAd(tx, userId, adId, effectKindOwnedBy(reason));
    if (plan.kind === 'mute') {
      await muteCompany(tx, userId, { adId, company: plan.company, companyKey: plan.companyKey });
    }
    return plan;
  });
  revalidateFeedback();
  return outcome;
}

/**
 * The user picked one of the proposed exclude terms. Recomputed here rather
 * than trusted from the client: only a term the suggestion would still make
 * is saved, and only to the directions it names.
 */
export async function acceptExcludeSuggestion(
  adId: string,
  term: string,
): Promise<{ saved: boolean; directions: string[] }> {
  const userId = await currentUserId();
  const result = await withTenant(userId, async (tx) => {
    const ad = await recordDismissReason(tx, userId, adId, 'wrong_role');
    if (!ad) return { saved: false, directions: [] };
    const suggestion = suggestExcludeTerms(ad, await listInterestedDirections(tx, userId));
    if (!suggestion || !suggestion.terms.includes(term)) return { saved: false, directions: [] };
    await addExcludeFromDismissal(tx, userId, {
      adId,
      directionIds: suggestion.directions.map((d) => d.id),
      term,
    });
    return { saved: true, directions: suggestion.directions.map((d) => d.label) };
  });
  revalidateFeedback();
  return result;
}

/** Take back the exclude term(s) this dismissal added — the follow-up's own undo. */
export async function removeExcludeFromAd(adId: string): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, (tx) => removeEffectsFromAd(tx, userId, adId, 'mute_company'));
  revalidateFeedback();
}

/** Remove one saved effect (Profile → "From your dismissals"). */
export async function removeFeedback(effectId: string): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, (tx) => removeFeedbackEffect(tx, userId, effectId));
  revalidateFeedback();
}

/** Unmute by name — what the card and the follow-up have to hand. */
export async function unmuteCompany(company: string): Promise<void> {
  const key = companyKey(company);
  if (!key) return;
  const userId = await currentUserId();
  await withTenant(userId, (tx) => dbUnmuteCompany(tx, userId, key));
  revalidateFeedback();
}
