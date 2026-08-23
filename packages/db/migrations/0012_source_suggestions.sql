-- Auto-discovery of ATS boards: sources can now be in a 'suggested' state
-- (system found the board via HTTP probing) before the user approves them.
-- Suggested sources are shown in the UI but not fetched until approved.
ALTER TYPE "source_status" ADD VALUE 'suggested';
