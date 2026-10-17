import type { PollKey } from '../model/pollKey';
import { CHARTERS_CONTRACT_ID } from './documents';

const DOCUMENT_TYPE = 'electedCharter';
const INDEX_NAME = 'byTargetContract';

export const CHARTER_INDEX = { documentTypeName: DOCUMENT_TYPE, indexName: INDEX_NAME } as const;

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

/** The election hub of a target contract. */
export function moderatedHref(targetContractId: string): string {
  return `#/m/${targetContractId}`;
}

/** A proposal's page. */
export function proposalHref(targetContractId: string, submittedCharterId: string): string {
  return `#/m/${targetContractId}/charter/${submittedCharterId}`;
}
