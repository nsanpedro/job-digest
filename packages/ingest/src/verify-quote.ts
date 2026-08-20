/**
 * Re-exported from @job-digest/core, which both the ad pipeline (here) and
 * the CV role-discovery pipeline need — see core/src/verify-quote.ts for the
 * implementation and why it moved. Kept here so existing relative imports
 * ('../src/verify-quote') and the package barrel keep working unchanged.
 */
export { normalizeWhitespace, verifyQuote } from '@job-digest/core';
