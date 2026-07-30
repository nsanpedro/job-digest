import { describe, expect, it } from 'vitest';
import { classify, domainMatches } from '../src/classify';
import { declaredCount } from '../src/declare';
import { layoutHash } from '../src/layout-hash';
import { normalizeWhitespace, verifyQuote } from '../src/verify-quote';

describe('classify — the I14 allowlist boundary', () => {
  it('maps allowlisted sender domains to their platform', () => {
    expect(classify('jobalerts-noreply@linkedin.com')).toBe('LinkedIn');
    expect(classify('mailer@news.xing.com')).toBe('Xing');
    expect(classify('alert@indeed.com')).toBe('Indeed');
    expect(classify('noreply@stepstone.de')).toBe('StepStone');
  });

  it('rejects everything else', () => {
    expect(classify('newsletter@example.com')).toBe('not_allowlisted');
    expect(classify('not-an-address')).toBe('not_allowlisted');
  });

  it('closes the SEARCH substring hole (§4.4): lookalike domains do not match', () => {
    // IMAP SEARCH FROM "linkedin.com" would match all of these; we must not.
    expect(classify('jobs@linkedin.com.example.ru')).toBe('not_allowlisted');
    expect(classify('jobs@notlinkedin.com')).toBe('not_allowlisted');
    expect(classify('jobs@linkedin.community')).toBe('not_allowlisted');
    expect(domainMatches('linkedin.com.evil.ru', 'linkedin.com')).toBe(false);
  });
});

describe('layoutHash — structural fingerprint (§5.3)', () => {
  const template = (title: string, company: string) => `
    <table class="wrap"><tr><td class="job">
      <a class="title" href="#">${title}</a>
      <span class="company">${company}</span>
    </td></tr></table>`;

  it('is identical for different content in the same template', () => {
    expect(layoutHash(template('Sachbearbeiterin (m/w/d)', 'Hansa Logistik'))).toBe(
      layoutHash(template('Teamassistenz', 'Nordlicht Steuerberatung')),
    );
  });

  it('changes when the structure changes', () => {
    const changed = `
      <table class="wrap"><tr><td class="job">
        <img class="header" src="x"/>
        <a class="title" href="#">T</a>
      </td></tr></table>`;
    expect(layoutHash(changed)).not.toBe(layoutHash(template('T', 'C')));
  });

  it('is insensitive to class order', () => {
    expect(layoutHash('<div class="a b"><p>x</p></div>')).toBe(
      layoutHash('<div class="b a"><p>y</p></div>'),
    );
  });
});

describe('verifyQuote — the I5 gate', () => {
  const source = `<td>Gleitzeit zwischen 07:00 und 19:00,\n   Mo–Fr</td>
    <td>2.900 – 3.300 € brutto/Monat</td>`;

  it('accepts a literal quote across whitespace differences', () => {
    expect(verifyQuote('Gleitzeit zwischen 07:00 und 19:00, Mo–Fr', source)).toBe(true);
  });

  it('normalizes NBSP in German number formatting', () => {
    expect(verifyQuote('2.900 – 3.300 € brutto/Monat', source)).toBe(true);
  });

  it('rejects text the model made up — the field degrades to unknown', () => {
    expect(verifyQuote('unbefristete Festanstellung', source)).toBe(false);
  });

  it('rejects a paraphrase, not just an invention', () => {
    expect(verifyQuote('Gleitzeit von 07:00 bis 19:00', source)).toBe(false);
  });

  it('rejects the empty quote', () => {
    expect(verifyQuote('', source)).toBe(false);
    expect(verifyQuote('   ', source)).toBe(false);
  });

  it('strips soft hyphens that email HTML inserts mid-word', () => {
    expect(normalizeWhitespace('unbe­fristet')).toBe('unbefristet');
  });
});

describe('declaredCount — I3, the self-declared yardstick', () => {
  it('reads LinkedIn German and English subjects', () => {
    expect(declaredCount('LinkedIn', '10 neue Jobs für „Büromanagement Hamburg“').count).toBe(10);
    expect(declaredCount('LinkedIn', '3 new jobs for "Sachbearbeitung"').count).toBe(3);
  });

  it('reads StepStone subjects', () => {
    expect(declaredCount('StepStone', 'Ihr Job-Alarm: 4 neue Stellen in Hamburg').count).toBe(4);
  });

  it('records absence with a reason, never a guess (I3)', () => {
    const d = declaredCount('Xing', 'Neue Jobs für dich: Sachbearbeitung Hamburg');
    expect(d.count).toBeNull();
    expect(d.reason).toBeTruthy();
  });

  it('an unmatched subject is null with a reason, not zero', () => {
    const d = declaredCount('LinkedIn', 'Deine Bewerbung wurde angesehen');
    expect(d.count).toBeNull();
    expect(d.reason).toBeTruthy();
  });
});
