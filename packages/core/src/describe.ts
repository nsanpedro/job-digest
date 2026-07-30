/**
 * English descriptions of conditions and predicates, used in explanation
 * steps. The UI chrome is English; ad content stays German (design,
 * "Idioma de la interfaz").
 */
import type { ConditionByKey, Predicate, RuleKey } from './types';

/** German-style currency formatting, matching the prototype: "2.600 €". */
export const eur = (n: number): string => `${n.toLocaleString('de-DE')} €`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describePredicate(p: Predicate): string {
  switch (p.kind) {
    case 'homeAtLeast':
      return p.days >= 5 ? 'fully remote' : `at least ${plural(p.days, 'home-office day')} a week`;
    case 'payAtLeast':
      return `pay of at least ${eur(p.amount)} full-time equivalent`;
    case 'commuteUnder':
      return `a commute under ${p.minutes} min`;
  }
}

/** The fact a predicate consults — named in `undecidable` steps (I12). */
export function predicateFactName(p: Predicate): string {
  switch (p.kind) {
    case 'homeAtLeast':
      return 'home-office days';
    case 'payAtLeast':
      return 'pay';
    case 'commuteUnder':
      return 'commute time';
  }
}

export function describeCondition<K extends RuleKey>(key: K, condition: ConditionByKey[K]): string {
  switch (key) {
    case 'Shift': {
      const c = condition as ConditionByKey['Shift'];
      const parts: string[] = [];
      if (c.noRotating) parts.push('no rotating shifts');
      if (c.noWeekend) parts.push('no weekend work');
      return parts.length ? parts.join(', ') : 'no working-time limit';
    }
    case 'German': {
      const c = condition as ConditionByKey['German'];
      return `German demanded at most ${c.maxDemanded}`;
    }
    case 'Onsite': {
      const c = condition as ConditionByKey['Onsite'];
      return c.minHomeDays <= 0
        ? 'no home-office minimum'
        : `at least ${plural(c.minHomeDays, 'home-office day')} a week`;
    }
    case 'Pay': {
      const c = condition as ConditionByKey['Pay'];
      return `at least ${eur(c.minMonthly)} ${c.basis === 'fte' ? 'full-time equivalent' : 'actual monthly'}`;
    }
    default: {
      const c = condition as ConditionByKey['Contract'];
      return c.permanentOnly ? 'permanent contract only' : 'any contract type';
    }
  }
}
