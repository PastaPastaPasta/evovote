import { base58Decode, base58Encode, base64ToBytesSafe } from '../model/bytes';

/**
 * Charter documents as the app models them. The mappers are pure and read a
 * document's JSON (`Document.toJSON(version)`, plus `$id`/`$ownerId`).
 *
 * Identifier properties come back in more than one form: a document read
 * from chain renders them as base58 (verified on rc.4), a document built
 * without its contract as base64, and `toObject()` as bytes. `idFromValue`
 * accepts all of them.
 */

export const CHARTERS_CONTRACT_ID = 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88';

/** A `reason` a team may cite. */
export interface CharterReason {
  id: string;
  ownerId: string;
  code: string;
  label: string;
  description?: string;
}

export interface RewardSplit {
  leader: number;
  equal: number;
  actions: number;
}

/** A `submittedCharter`: a leader's proposal. */
export interface CharterProposal {
  id: string;
  leaderId: string;
  targetContractId: string;
  description: string;
  reasonIds: string[];
  /** Percent of the declared moderators fee the team takes; absent means 100. */
  moderatorsShare: number;
  rewardSplit?: RewardSplit;
  createdAtMs?: number;
}

/** An `electedCharter`: a proposal put to the vote with its team. */
export interface ElectedCharter {
  id: string;
  leaderId: string;
  targetContractId: string;
  submittedCharterId: string;
  members: string[];
  createdAtMs?: number;
}

/** What anyone may see of a `joinRequest`: who asked and when, never the message. */
export interface JoinRequestMeta {
  id: string;
  memberId: string;
  submittedCharterId: string;
  recipientKeyId?: number;
  senderKeyId?: number;
  createdAtMs?: number;
}

/** Any identifier form to base58; undefined when it is not 32 bytes. */
export function idFromValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object' && 'toBase58' in value && typeof value.toBase58 === 'function') {
    try {
      return String((value as { toBase58(): string }).toBase58());
    } catch {
      return undefined;
    }
  }
  let bytes: Uint8Array | undefined;
  if (value instanceof Uint8Array) bytes = value;
  else if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
    bytes = Uint8Array.from(value as number[]);
  } else if (typeof value === 'string') {
    // Base58 first: a base58 id never contains + / or =.
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
      try {
        if (base58Decode(value).length === 32) return value;
      } catch {
        // fall through to base64
      }
    }
    bytes = base64ToBytesSafe(value);
  }
  return bytes && bytes.length === 32 ? base58Encode(bytes) : undefined;
}

const asNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(idFromValue).filter((id): id is string => id !== undefined) : [];

type Json = Record<string, unknown>;

const docId = (doc: Json, fallbackId?: string) => idFromValue(doc.$id) ?? fallbackId ?? '';

export function toReason(doc: Json, fallbackId?: string): CharterReason {
  return {
    id: docId(doc, fallbackId),
    ownerId: idFromValue(doc.$ownerId) ?? '',
    code: typeof doc.code === 'string' ? doc.code : '',
    label: typeof doc.label === 'string' ? doc.label : '',
    ...(typeof doc.description === 'string' ? { description: doc.description } : {}),
  };
}

export function toProposal(doc: Json, fallbackId?: string): CharterProposal {
  const split = doc.rewardSplit as Json | undefined;
  const leader = asNumber(split?.leader);
  const equal = asNumber(split?.equal);
  const actions = asNumber(split?.actions);
  return {
    id: docId(doc, fallbackId),
    leaderId: idFromValue(doc.$ownerId) ?? '',
    targetContractId: idFromValue(doc.targetContractId) ?? '',
    description: typeof doc.description === 'string' ? doc.description : '',
    reasonIds: idList(doc.reasons),
    moderatorsShare: asNumber(doc.moderatorsShare) ?? 100,
    rewardSplit:
      leader !== undefined && equal !== undefined && actions !== undefined
        ? { leader, equal, actions }
        : undefined,
    createdAtMs: asNumber(doc.$createdAt),
  };
}

export function toElectedCharter(doc: Json, fallbackId?: string): ElectedCharter {
  return {
    id: docId(doc, fallbackId),
    leaderId: idFromValue(doc.$ownerId) ?? '',
    targetContractId: idFromValue(doc.targetContractId) ?? '',
    submittedCharterId: idFromValue(doc.submittedCharterId) ?? '',
    members: idList(doc.members),
    createdAtMs: asNumber(doc.$createdAt),
  };
}

export function toJoinRequestMeta(doc: Json, fallbackId?: string): JoinRequestMeta {
  return {
    id: docId(doc, fallbackId),
    memberId: idFromValue(doc.$ownerId) ?? '',
    submittedCharterId: idFromValue(doc.submittedCharterId) ?? '',
    recipientKeyId: asNumber(doc.recipientKeyId),
    senderKeyId: asNumber(doc.senderKeyId),
    createdAtMs: asNumber(doc.$createdAt),
  };
}

/** "leader 40% · equal 30% · actions 30%". */
export function splitText(split: RewardSplit | undefined): string {
  if (!split) return 'not readable';
  return `leader ${split.leader}% · equal ${split.equal}% · by actions ${split.actions}%`;
}
