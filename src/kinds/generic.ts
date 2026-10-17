import { choicesForResolution } from '../model/contest';
import { displayIndexValue } from '../model/indexValue';
import type { ContestKind } from './types';

/** Render one document field for a key/value table. */
function fieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/**
 * Any contract's contested index: the fallback that makes every poll
 * visible. WP1 renders a minimal view; WP5 adds the contract browser.
 */
export const genericKind: ContestKind = {
  id: 'generic',
  label: 'Other contests',
  matches: () => true,
  title: (c) =>
    `${c.key.documentTypeName} · ${c.key.indexValues.map(displayIndexValue).join(' / ')}`,
  async describeContender(_sdk, _c, contender) {
    const doc = contender.document ?? {};
    return {
      identityId: contender.identityId,
      fields: Object.entries(doc)
        .filter(([k]) => !k.startsWith('$') || k === '$id')
        .map(([k, v]) => [k, fieldText(v)]),
    };
  },
  // The resolution comes from the contract's index definition. If it could
  // not be read, Lock is withheld: offering it on a resolution-1 index only
  // earns a 40307 refusal.
  choices: (c) => (c.resolution === 0 ? choicesForResolution(0) : choicesForResolution(1)),
};
