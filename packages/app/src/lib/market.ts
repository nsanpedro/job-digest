/**
 * City → market inference, shared across onboarding and post-onboarding flows.
 * Kept in a plain module (not `'use server'`) so both server actions and
 * synchronous helpers can import without turning every export into a server
 * action.
 */

export type Market = 'DACH' | 'ES' | 'AR' | 'ALL';

const DACH = [
  'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln',
  'düsseldorf', 'stuttgart', 'vienna', 'wien', 'zurich', 'zürich', 'bern', 'geneva',
];
const ES = [
  'barcelona', 'madrid', 'valencia', 'sevilla', 'bilbao', 'zaragoza',
  'málaga', 'malaga', 'palma', 'alicante',
];
const AR = ['buenos aires', 'córdoba', 'cordoba', 'rosario', 'mendoza', 'tucumán', 'tucuman'];

export function inferMarket(city: string | null): Market {
  if (!city) return 'ALL';
  const lower = city.toLowerCase();
  if (DACH.some((c) => lower.includes(c))) return 'DACH';
  if (ES.some((c) => lower.includes(c))) return 'ES';
  if (AR.some((c) => lower.includes(c))) return 'AR';
  return 'ALL';
}

export function marketLabel(m: Market): string {
  switch (m) {
    case 'DACH': return 'Germany, Austria & Switzerland';
    case 'ES':   return 'Spain';
    case 'AR':   return 'Argentina';
    case 'ALL':  return 'All markets';
  }
}
