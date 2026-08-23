import { normalizePay } from '../../packages/ingest/src';
// Test various formats from Ashby
const tests = [
  '€110K – €185K',
  '€110K - €185K',
  '110000 - 185000 EUR annual',
  '$150K - $210K',
  '€110,000 – €185,000',
];
for (const t of tests) {
  const result = normalizePay(t);
  console.log(`"${t}" → ${JSON.stringify(result)}`);
}
