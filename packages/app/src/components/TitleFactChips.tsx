import type { TitleFacts } from '@job-digest/core';
import styles from './TitleFactChips.module.css';

/**
 * Chips = hechos, no veredictos (Nico, 3 Aug 2026).
 *
 * `RuleLane` answers "how does this ad score against your rules" — a
 * pass/warn/block/unknown *verdict*. Measured against the corpus, that
 * question is unanswerable for most rules most of the time: the alert body
 * the verdict would come from is not in the email (§12 rules out fetching
 * it). This component answers a different, answerable question: "what does
 * the title and location line actually say" — a *fact*, with no severity and
 * no judgment attached. Deliberately styled as neutral, not colored like
 * `STATE_VISUALS`: a "Senior" chip is not a pass, and must not read like one.
 *
 * Extraction: `packages/ingest/src/normalize/title-facts.ts`. Measured
 * coverage on the 123-ad corpus (3 Aug 2026): discipline 80%, workplace 29%,
 * seniority 39%, stack 18% — average 1.67 populated facts per ad, against
 * roughly 0.6 from the rule lane alone. `employment` (1%) and `germanTitle`
 * are not rendered here: too sparse to be worth a chip, and germanTitle is
 * visible in the title itself.
 */
const SENIORITY_LABEL: Record<NonNullable<TitleFacts['seniority']>['value'], string> = {
  junior: 'Junior',
  senior: 'Senior',
  lead: 'Lead',
  principal: 'Principal',
  head: 'Head',
};

const DISCIPLINE_LABEL: Record<NonNullable<TitleFacts['discipline']>['value'], string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  fullstack: 'Fullstack',
  mobile: 'Mobile',
  data: 'Data',
  devops: 'DevOps',
  management: 'Management',
  consulting: 'Consulting',
};

const WORKPLACE_LABEL: Record<NonNullable<TitleFacts['workplace']>['value'], string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
};

function Chip({ text, matched }: { text: string; matched: string }) {
  // The literal span is the tooltip, not printed text — same citation
  // discipline as RuleLane's quotes (I5's shape), kept out of the chip body
  // so "Senior" doesn't become "Senior (matched: \"senior\")" on every card.
  return (
    <span className={styles.chip} title={`from “${matched}”`}>
      {text}
    </span>
  );
}

export function TitleFactChips({ facts }: { facts: TitleFacts | null }) {
  if (!facts) return null;

  const { seniority, discipline, workplace, remotePercent, stack } = facts;
  if (!seniority && !discipline && !workplace && stack.length === 0) return null;

  return (
    <div className={styles.row}>
      {seniority && <Chip text={SENIORITY_LABEL[seniority.value]} matched={seniority.matched} />}
      {discipline && <Chip text={DISCIPLINE_LABEL[discipline.value]} matched={discipline.matched} />}
      {workplace && (
        <Chip
          text={
            remotePercent && workplace.value === 'remote'
              ? `${remotePercent.value}% Remote`
              : WORKPLACE_LABEL[workplace.value]
          }
          matched={remotePercent ? remotePercent.matched : workplace.matched}
        />
      )}
      {stack.map((s) => (
        <Chip key={s.value} text={s.value} matched={s.matched} />
      ))}
    </div>
  );
}
