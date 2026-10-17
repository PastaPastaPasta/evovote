import {
  contractJson,
  documentSchema,
  fetchContract,
  type ContestedIndex,
  type FieldMatch,
} from '../discovery/contracts';
import { choicesForResolution, type Resolution } from '../model/contest';
import { displayIndexValue } from '../model/indexValue';
import { documentRows } from './fields';
import type { ContestKind } from './types';

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id);

/**
 * What a resolution means for voters, in plain words. `undefined` (the
 * index could not be read) says so rather than guessing.
 */
export function resolutionWords(resolution: Resolution | undefined): string {
  if (resolution === 0) {
    return 'Masternodes vote for a contender, abstain, or lock the resource. If Lock wins, nobody gets it.';
  }
  if (resolution === 1) {
    return 'Masternodes vote for a contender or abstain. Lock is not allowed, so there is always a winner; a tie goes to the earliest contender.';
  }
  return 'The contract’s index could not be read, so the voting rule is unknown. Lock is withheld to be safe.';
}

/** The `fieldMatches` rules as sentences: when a document goes to a vote. */
export function fieldMatchWords(fieldMatches: readonly FieldMatch[]): string[] {
  if (fieldMatches.length === 0) {
    return ['No field filter: every new document on this index enters a masternode vote.'];
  }
  return [
    ...fieldMatches.map((m) => `A vote opens only if “${m.field}” matches ${m.regexPattern}.`),
    'Documents that do not match are created normally, with no vote.',
  ];
}

/** The index's own description, rules and resolution, as lines for a page. */
export function describeIndex(index: ContestedIndex): string[] {
  return [
    ...(index.description ? [index.description] : []),
    resolutionWords(index.resolution),
    ...fieldMatchWords(index.fieldMatches),
  ];
}

/**
 * Any contract's contested index: the fallback that makes every poll
 * visible. The title carries the document type, the decoded index values and
 * the contract; a contender shows its decoded document as typed rows.
 */
export const genericKind: ContestKind = {
  id: 'generic',
  label: 'Other contests',
  matches: () => true,
  title: (c) =>
    `${c.key.documentTypeName} · ${c.key.indexValues
      .map((v) => (v.type === 'identifier' ? shortId(v.value) : clip(displayIndexValue(v), 40)))
      .join(' / ')} · ${shortId(c.key.contractId)}`,
  async describeContender(sdk, c, contender) {
    const doc = contender.document;
    if (!doc) return { identityId: contender.identityId };
    // The schema says which strings are identifiers and which arrays are
    // bytes; without it (contract unreadable) the heuristics still apply.
    let schema: unknown;
    try {
      const contract = await fetchContract(sdk, c.key.contractId);
      if (contract) schema = documentSchema(contractJson(sdk, contract), c.key.documentTypeName);
    } catch {
      // Rows render untyped.
    }
    return { identityId: contender.identityId, rows: documentRows(doc, schema) };
  },
  // The resolution comes from the contract's index definition. If it could
  // not be read, Lock is withheld: offering it on a resolution-1 index only
  // earns a 40307 refusal.
  choices: (c) => choicesForResolution(c.resolution === 0 ? 0 : 1),
};
