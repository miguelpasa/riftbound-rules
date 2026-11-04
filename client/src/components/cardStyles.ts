import type { CSSProperties } from 'react';
import type { CardDef, CardType, Domain } from '@riftbound/engine';

export type CardSize = 'hand' | 'board' | 'chain' | 'detail';

export const DOMAIN_COLORS: Record<Domain, { base: string; dark: string; label: string }> = {
  Fury: { base: '#ef4444', dark: '#450a0a', label: 'Fury' },
  Calm: { base: '#14b8a6', dark: '#042f2e', label: 'Calm' },
  Mind: { base: '#3b82f6', dark: '#0c1a3d', label: 'Mind' },
  Body: { base: '#f97316', dark: '#431407', label: 'Body' },
  Chaos: { base: '#a855f7', dark: '#2e1065', label: 'Chaos' },
  Order: { base: '#eab308', dark: '#3b2a03', label: 'Order' },
};

export const COLORLESS = { base: '#9ca3af', dark: '#1f2430', label: 'Colorless' };

export const SIZE_CLASSES: Record<CardSize, string> = {
  hand: 'w-40 h-56 text-[11px]',
  board: 'w-28 h-40 text-[9px]',
  chain: 'w-24 h-32 text-[8px]',
  detail: 'w-72 h-[25rem] text-sm',
};

export const TYPE_LABELS: Record<CardType, string> = {
  UNIT: 'Unit',
  SPELL: 'Spell',
  GEAR: 'Gear',
  LEGEND: 'Legend',
  RUNE: 'Rune',
  BATTLEFIELD: 'Battlefield',
  TOKEN: 'Token',
};

export function domainColor(d: Domain) {
  return DOMAIN_COLORS[d] ?? COLORLESS;
}

/** Border colour + background gradient for a card's domains (grey if colorless). */
export function frameStyle(domains: readonly Domain[]): CSSProperties {
  if (domains.length === 0) {
    return {
      borderColor: COLORLESS.base,
      background: `linear-gradient(160deg, ${COLORLESS.dark}, #11151f)`,
    };
  }
  if (domains.length === 1) {
    const c = domainColor(domains[0]!);
    return { borderColor: c.base, background: `linear-gradient(160deg, ${c.dark}, #0f131c)` };
  }
  const stops = domains.map((d) => domainColor(d).base);
  return {
    borderImage: `linear-gradient(135deg, ${stops.join(', ')}) 1`,
    borderColor: stops[0],
    background: `linear-gradient(160deg, ${domains.map((d) => domainColor(d).dark).join(', ')})`,
  };
}

export function typeLine(def: CardDef): string {
  const parts = [TYPE_LABELS[def.type] ?? def.type, ...def.subtypes];
  return parts.join(' · ');
}

export function keywordLabel(k: { name: string; value?: number }): string {
  return k.value !== undefined ? `${k.name} ${k.value}` : k.name;
}

export type TextToken =
  | { kind: 'text'; text: string }
  | { kind: 'reminder'; text: string }
  | { kind: 'symbol'; symbol: 'E' | 'M' | 'C' | 'A' | 'N'; value?: string }
  | { kind: 'keyword'; text: string };

/** Splits rules text into plain text, reminder text "(...)", and bracket symbols. */
export function tokenizeRulesText(text: string): TextToken[] {
  const out: TextToken[] = [];
  const re = /\[([^\]]+)\]|\(([^)]*)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[2] !== undefined) {
      out.push({ kind: 'reminder', text: m[2] });
    } else {
      const inner = m[1]!.trim();
      const up = inner.toUpperCase();
      if (up === 'E' || up === 'M' || up === 'C' || up === 'A') {
        out.push({ kind: 'symbol', symbol: up });
      } else if (/^\d+$/.test(inner)) {
        out.push({ kind: 'symbol', symbol: 'N', value: inner });
      } else {
        out.push({ kind: 'keyword', text: inner });
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export const SYMBOL_INFO: Record<'E' | 'M' | 'C' | 'A' | 'N', string> = {
  E: 'Exhaust',
  M: 'Might',
  C: 'Domain power',
  A: 'Any power',
  N: 'Energy',
};
