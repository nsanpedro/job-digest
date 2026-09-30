import { describe, expect, it } from 'vitest';
import {
  followUpItems,
  followUpReducer,
  hasFollowUps,
  type FollowUpState,
} from '../src/dismiss-follow-up';

type Ad = { id: string; title: string };
const ad = (id: string): Ad => ({ id, title: `Title ${id}` });
const empty: FollowUpState<Ad> = new Map();

const dismiss = (state: FollowUpState<Ad>, a: Ad, list: string, index: number, reason: 'company' | null = null) =>
  followUpReducer(state, { type: 'dismissed', ad: a, list, index, reason });

const kinds = (items: ReturnType<typeof followUpItems<Ad>>) =>
  items.map((i) => `${i.kind === 'card' ? 'card' : 'follow'}:${i.ad.id}`);

describe('followUpReducer', () => {
  it('records a dismissal with its list, position and reason', () => {
    const s = dismiss(empty, ad('a'), 'curated', 2, 'company');
    expect(s.get('a')).toEqual({ ad: ad('a'), list: 'curated', index: 2, reason: 'company' });
    expect(empty.size).toBe(0);
  });

  it('closing removes only that row; closing an unknown id is a no-op', () => {
    const s = dismiss(dismiss(empty, ad('a'), 'curated', 0), ad('b'), 'worth', 1);
    const closed = followUpReducer(s, { type: 'closed', id: 'a' });
    expect([...closed.keys()]).toEqual(['b']);
    expect(followUpReducer(closed, { type: 'closed', id: 'zzz' })).toBe(closed);
  });

  it('dismissing again replaces the earlier entry', () => {
    const s = dismiss(dismiss(empty, ad('a'), 'curated', 0), ad('a'), 'curated', 3, 'company');
    expect(s.size).toBe(1);
    expect(s.get('a')).toMatchObject({ index: 3, reason: 'company' });
  });
});

describe('followUpItems', () => {
  it('replaces the card in place while the server still lists the ad', () => {
    const s = dismiss(empty, ad('b'), 'curated', 1);
    expect(kinds(followUpItems([ad('a'), ad('b'), ad('c')], s, 'curated'))).toEqual([
      'card:a',
      'follow:b',
      'card:c',
    ]);
  });

  it('re-inserts at the old position once the server has moved the ad out', () => {
    const s = dismiss(empty, ad('b'), 'curated', 1);
    expect(kinds(followUpItems([ad('a'), ad('c')], s, 'curated'))).toEqual(['card:a', 'follow:b', 'card:c']);
  });

  it('keeps several moved rows in their original order', () => {
    let s = dismiss(empty, ad('a'), 'curated', 0);
    s = dismiss(s, ad('c'), 'curated', 1); // displayed list was [follow:a, card:c, card:d]
    expect(kinds(followUpItems([ad('d')], s, 'curated'))).toEqual(['follow:a', 'follow:c', 'card:d']);
  });

  it('survives the list going empty: the last curated ad dismissed', () => {
    const s = dismiss(empty, ad('only'), 'curated', 0, 'company');
    const items = followUpItems<Ad>([], s, 'curated');
    expect(items).toEqual([{ kind: 'followUp', ad: ad('only'), reason: 'company' }]);
    expect(hasFollowUps(s, 'curated')).toBe(true);
  });

  it('clamps a stale position to the end of a shorter list', () => {
    const s = dismiss(empty, ad('z'), 'curated', 9);
    expect(kinds(followUpItems([ad('a')], s, 'curated'))).toEqual(['card:a', 'follow:z']);
  });

  it('shows a dismissal only in the list it came from', () => {
    const s = dismiss(empty, ad('w'), 'worth', 0);
    expect(kinds(followUpItems([ad('a')], s, 'curated'))).toEqual(['card:a']);
    expect(kinds(followUpItems([ad('b')], s, 'worth'))).toEqual(['follow:w', 'card:b']);
    expect(hasFollowUps(s, 'curated')).toBe(false);
    expect(hasFollowUps(s, 'worth')).toBe(true);
  });

  it('is back to plain cards once the row is closed', () => {
    const s = followUpReducer(dismiss(empty, ad('a'), 'curated', 0), { type: 'closed', id: 'a' });
    expect(kinds(followUpItems([ad('a'), ad('b')], s, 'curated'))).toEqual(['card:a', 'card:b']);
    expect(followUpItems<Ad>([], s, 'curated')).toEqual([]);
  });
});
