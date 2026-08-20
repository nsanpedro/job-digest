export { withTenant, type Db, type Tx } from './tenant';
export { ingestEmail, PARSER_VERSION, type IngestInput, type IngestResult } from './ingest-email';
export { classifyOutcome, type CauseCode, type Outcome, type OutcomeVerdict } from './outcome';
export { mergeFacts, type FactConflict, type MergeResult } from './merge-facts';
export {
  GmailAuthError,
  allowlistQuery,
  credentialKey,
  fetchRawMessage,
  ingestFromGmail,
  listAllowlistedMessageIds,
  refreshAccessToken,
  type GmailIngestSummary,
} from './gmail';
export {
  generateInboundAddress,
  ingestForwardedEmail,
  verifyForwardedSender,
  type ForwardingIngestResult,
  type ForwardingVerdict,
} from './forwarding';
export {
  deriveDirections,
  DIRECTIONS_MODEL,
  MAX_AD_TITLES,
  PROMPT_VERSION as DIRECTIONS_PROMPT_VERSION,
  type DeriveDirectionsInput,
  type DeriveDirectionsResult,
} from './derive-directions';
