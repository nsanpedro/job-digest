/**
 * Shared concurrency helpers for the worker.
 *
 * Extracted from `gmail.ts` and `fetch-apis.ts`, which each carried an
 * identical `mapWithConcurrency` — the copy was fine while the pattern
 * lived in exactly two files, but the same shape is now needed at every
 * worker fan-out (refresh-onboarding.ts, discover-sources.ts) to keep the
 * per-request connection count under the pool cap. One source of truth
 * here; the callers set their own limit.
 *
 * The name is deliberate: "map" because the caller returns a Promise per
 * item, "with concurrency" because at most `limit` promises are in flight
 * at any moment. Errors in one worker do NOT stop the others — each caller
 * decides what to do inside `fn` (log-and-continue is the pattern all four
 * current callers use).
 *
 * Pure, no state, safe to call anywhere.
 */

export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
