export { withTenant, type Db, type Tx } from './tenant';
export { ingestEmail, PARSER_VERSION, type IngestInput, type IngestResult } from './ingest-email';
export { classifyOutcome, type CauseCode, type Outcome, type OutcomeVerdict } from './outcome';
export { mergeFacts, type FactConflict, type MergeResult } from './merge-facts';
