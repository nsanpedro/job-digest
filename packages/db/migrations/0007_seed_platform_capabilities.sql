-- Seeds platform_capabilities (design §9) with only what the codebase has
-- real evidence for — a comment in an extractor, or measured coverage across
-- stored ads — never a guess dressed up as data. That is the same honesty
-- rule I4 applies to facts, applied one level up: an unseeded (platform,
-- field) pair means "we don't know yet", and the UI keeps showing "not read"
-- for it rather than a confident claim this migration can't back up.
--
-- shift and contract are deliberately absent for both platforms: nothing in
-- the extractors or normalizers makes a documented claim that either
-- platform's alert cards never carry that data, only that today's code
-- doesn't populate it — which is a claim about the reader, not the ad, and
-- the whole point of this table is not to conflate the two.
--
-- Indeed and StepStone are absent entirely: no extractor exists yet (§14 —
-- fixtures pending), so there is nothing to have evidence about.
INSERT INTO platform_capabilities (platform, fields) VALUES
  ('LinkedIn', '{"pay": false, "german": false}'),
  ('Xing', '{"pay": true, "german": false}')
ON CONFLICT (platform) DO UPDATE SET fields = excluded.fields;
