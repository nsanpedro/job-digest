'use server';

/**
 * Role discovery from a CV (docs/adr-001-role-discovery.md). Its own file
 * rather than folded into actions.ts: that file is already a grab-bag of
 * unrelated ad/ruleset/mailbox mutations, and this is a big enough new
 * subsystem (a third LLM call site, its own upload path, its own poll) to
 * deserve a clean boundary rather than one more export in an already-468-line
 * file.
 *
 * Mirrors startRefresh/runIngestion/getRunProgress in actions.ts exactly:
 * the action that kicks things off returns almost immediately, the real work
 * runs detached via after(), and a poll action reads status off the row the
 * first call already wrote.
 */
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import {
  completeDerivation,
  countDerivationsSince,
  getDerivationProgress as queryDerivationProgress,
  getDistinctAdTitles,
  setDirectionState as querySetDirectionState,
  startDerivation,
  failDerivation,
} from '@job-digest/db';
import { extractCvText, type CvExtractionFailure } from '@job-digest/ingest';
import { deriveDirections, DIRECTIONS_MODEL } from '@job-digest/worker';
import { currentUserId, withTenant } from './session';

/** Generous — a CV genuinely doesn't need re-deriving more than a few times a day; guards against a runaway client loop, not against a determined abuser. */
const MAX_DERIVATIONS_PER_DAY = 5;

function humanReadableExtractionError(reason: CvExtractionFailure): string {
  switch (reason) {
    case 'not_a_pdf':
      return 'That file is not a PDF. Export your CV as a PDF and try again.';
    case 'too_large':
      return 'That PDF is too large. Try exporting a smaller version (under 8 MB).';
    case 'too_many_pages':
      return 'That PDF has too many pages for a CV (over 10). Trim it down and try again.';
    case 'no_text_layer':
      return "We couldn't find any selectable text in that PDF — it looks scanned or image-only. Export a version with real text (most word processors do this by default) and try again.";
    case 'corrupt':
      return "That file couldn't be read as a PDF. Try re-exporting it.";
  }
}

/**
 * Start a derivation from an uploaded CV. Returns immediately with the new
 * profile's id — the caller polls `getDerivationProgress` from here, the
 * same shape RefreshButton already uses for startRefresh/getRunProgress.
 *
 * A `{ error }` result never starts a derivation at all: rate-limited and
 * unreadable-PDF are both known upfront, before any model call, so neither
 * needs the poll/running state — the caller can show the message directly.
 */
export async function uploadCv(formData: FormData): Promise<{ profileId: string; version: number } | { error: string }> {
  const userId = await currentUserId();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentCount = await withTenant(userId, (tx) => countDerivationsSince(tx, userId, since));
  if (recentCount >= MAX_DERIVATIONS_PER_DAY) {
    return { error: `You've reached today's limit of ${MAX_DERIVATIONS_PER_DAY} CV analyses. Try again tomorrow.` };
  }

  const file = formData.get('cv');
  if (!(file instanceof File)) {
    return { error: 'No file was uploaded.' };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const extraction = await extractCvText(bytes);
  if (!extraction.ok) {
    return { error: humanReadableExtractionError(extraction.reason) };
  }

  const adTitles = await withTenant(userId, (tx) => getDistinctAdTitles(tx, userId));
  const { profileId, version } = await withTenant(userId, (tx) => startDerivation(tx, userId));

  after(() => runDerivation({ userId, profileId, version, cvText: extraction.text, adTitles }));

  return { profileId, version };
}

/**
 * The work formerly impossible to do inline (a model call routinely takes
 * seconds), now running detached from the client's request — same split as
 * runIngestion. Nothing here can throw back to a caller that's already gone;
 * every path ends by writing to the profile row, the only channel left.
 */
async function runDerivation(params: {
  userId: string;
  profileId: string;
  version: number;
  cvText: string;
  adTitles: string[];
}): Promise<void> {
  const { userId, profileId, version, cvText, adTitles } = params;
  try {
    const result = await deriveDirections({ cvText, adTitles });

    if (result.refused) {
      await withTenant(userId, (tx) =>
        failDerivation(tx, userId, profileId, 'refused', 'The model declined to process this request.'),
      );
      return;
    }

    await withTenant(userId, (tx) =>
      completeDerivation(tx, userId, profileId, version, {
        skills: result.skills,
        directions: result.directions,
        dropped: result.dropped,
        promptVersion: result.promptVersion,
        model: DIRECTIONS_MODEL,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(userId, (tx) => failDerivation(tx, userId, profileId, 'internal', message));
  }
  revalidatePath('/profile');
}

/** Polled by CvIntake while a derivation is in flight — see RefreshButton's identical use of getRunProgress. */
export async function getDerivationProgress(profileId: string): Promise<{
  status: 'running' | 'ok' | 'error';
  errorMessage: string | null;
} | null> {
  const userId = await currentUserId();
  const progress = await withTenant(userId, (tx) => queryDerivationProgress(tx, userId, profileId));
  if (!progress) return null;
  return { status: progress.status, errorMessage: progress.errorMessage };
}

/**
 * The user's own decision on a direction (I18-adjacent: this is the user
 * acting, never the system inferring interest from behavior). Nothing here
 * computes anything — it records a choice, the same shape toggleSaved does
 * for ad_user_state.
 */
export async function setDirectionState(
  directionId: string,
  state: 'interested' | 'dismissed' | 'alert_configured',
): Promise<void> {
  const userId = await currentUserId();
  await withTenant(userId, (tx) => querySetDirectionState(tx, userId, directionId, state));
  revalidatePath('/profile');
}
