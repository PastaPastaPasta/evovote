import { sweepContestedResources } from '../discovery/archive';
import { choicesForResolution } from '../model/contest';
import { indexValueFromJs } from '../model/indexValue';
import type { PollKey } from '../model/pollKey';
import type { ContestKind } from './types';

/** The moderation charters system contract (protocol 14). */
export const CHARTERS_CONTRACT_ID = 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88';
const DOCUMENT_TYPE = 'electedCharter';
const INDEX_NAME = 'byTargetContract';

/** The poll key of a contract's moderator election. */
export function charterPollKey(targetContractId: string): PollKey {
  return {
    contractId: CHARTERS_CONTRACT_ID,
    documentTypeName: DOCUMENT_TYPE,
    indexName: INDEX_NAME,
    indexValues: [{ type: 'identifier', value: targetContractId }],
  };
}

/** The target contract of a charter key, or undefined if it is not one. */
export function charterTarget(key: PollKey): string | undefined {
  if (
    key.contractId !== CHARTERS_CONTRACT_ID ||
    key.documentTypeName !== DOCUMENT_TYPE ||
    key.indexName !== INDEX_NAME ||
    key.indexValues.length !== 1
  ) {
    return undefined;
  }
  const [target] = key.indexValues;
  // On chain the value is an Identifier. A Text-typed key would address a
  // different (nonexistent) poll, so it is left to the generic kind.
  return target.type === 'identifier' ? target.value : undefined;
}

const short = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id);

/**
 * Moderator elections (`electedCharter.byTargetContract`, resolution 1).
 *
 * WP1 stub: enough to list these polls and vote on them. WP2 adds the
 * known-contracts registry for titles, the charter/leader/member views and
 * the election hub.
 */
export const charterKind: ContestKind = {
  id: 'charter',
  label: 'Moderator elections',
  matches: (key) => charterTarget(key) !== undefined,
  title: (c) => `Moderators of ${short(charterTarget(c.key) ?? '?')}`,
  async describeContender(_sdk, _c, contender) {
    // TODO(WP2): leader DPNS name, charter description, reasons, members.
    return { identityId: contender.identityId, subtitle: 'charter leader' };
  },
  // Resolution 1: no Lock. There is always a winner; ties go to the earliest contender.
  choices: () => choicesForResolution(1),
  archive: (sdk) =>
    sweepContestedResources(sdk, {
      source: 'moderator election archive',
      contractId: CHARTERS_CONTRACT_ID,
      documentTypeName: DOCUMENT_TYPE,
      indexName: INDEX_NAME,
      prefix: [],
      toKey: (resource) => {
        const target = indexValueFromJs(resource, 'identifier');
        return target?.type === 'identifier' ? charterPollKey(target.value) : undefined;
      },
    }),
};
