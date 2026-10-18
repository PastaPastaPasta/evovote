/**
 * A contract's moderation declaration, read from its REGISTERED JSON
 * (`contract.toJSON().config.moderation`), never from a committed file:
 * the interim, the windows and the moderated types are what the chain froze
 * at creation.
 *
 * Wire shape (Platform book, "Elected Moderation"; wasm-sdk `ContractModerators`):
 *
 *   config.moderation = {
 *     banlist, suspensions, warnings,
 *     moderators: { $type: 'elected', joinWindow?, voteWindow?, electionDelay?,
 *                   maxAddedModerators?, moderatedDocumentTypes, interim,
 *                   ownerProtected?, seatContestable, challengeCoolDown? }
 *               | { $type: 'contractOwner' } | { $type: 'appointedModerators', identities }
 *   }
 */

/** One week: the window an elected declaration gets when it leaves one out. */
export const DEFAULT_WINDOW_SECONDS = 7 * 24 * 3600;

export type ModerationAbility =
  | 'deleteDocuments'
  | 'ban'
  | 'suspend'
  | 'warn'
  | 'changeDocumentFields';

export type InterimKind = 'contractOwner' | 'appointedModerators' | 'notYetUsable' | 'noModeration';

export interface Interim {
  kind: InterimKind | 'unknown';
  /** Appointed moderators (base58), for `appointedModerators`. */
  identities: string[];
}

export interface ElectedDeclaration {
  joinWindowSeconds: number;
  voteWindowSeconds: number;
  /** Seconds after the contract's creation before the first charter can apply. */
  electionDelaySeconds?: number;
  maxAddedModerators: number;
  moderatedDocumentTypes: Record<string, string[]>;
  interim: Interim;
  ownerProtected: boolean;
  /** Declared, but nothing reads it on protocol 14: a seat is never contested again. */
  seatContestable: boolean;
  challengeCoolDownSeconds?: number;
}

/** Who moderates a contract, as its config declares. */
export type ModerationDeclaration =
  | { kind: 'none' }
  | { kind: 'contractOwner' }
  | { kind: 'appointedModerators'; identities: string[] }
  | { kind: 'elected'; elected: ElectedDeclaration }
  | { kind: 'unknown'; rawType: string };

export interface ContractModeration {
  declaration: ModerationDeclaration;
  lists: { banlist: boolean; suspensions: boolean; warnings: boolean };
  /** The contract's creation time (ms), when the chain recorded one. */
  createdAtMs?: number;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const asCount = (v: unknown): number | undefined => {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function parseInterim(raw: unknown): Interim {
  const r = asRecord(raw);
  const type = r?.$type;
  switch (type) {
    case 'contractOwner':
    case 'notYetUsable':
    case 'noModeration':
      return { kind: type, identities: [] };
    case 'appointedModerators':
      return { kind: type, identities: stringList(r?.identities) };
    default:
      return { kind: 'unknown', identities: [] };
  }
}

function parseElected(m: Record<string, unknown>): ElectedDeclaration {
  const types: Record<string, string[]> = {};
  const declared = asRecord(m.moderatedDocumentTypes);
  if (declared) {
    for (const [name, abilities] of Object.entries(declared)) types[name] = stringList(abilities);
  }
  return {
    joinWindowSeconds: asCount(m.joinWindow) ?? DEFAULT_WINDOW_SECONDS,
    voteWindowSeconds: asCount(m.voteWindow) ?? DEFAULT_WINDOW_SECONDS,
    electionDelaySeconds: asCount(m.electionDelay),
    maxAddedModerators: asCount(m.maxAddedModerators) ?? 0,
    moderatedDocumentTypes: types,
    interim: parseInterim(m.interim),
    ownerProtected: m.ownerProtected === true,
    seatContestable: m.seatContestable === true,
    challengeCoolDownSeconds: asCount(m.challengeCoolDown),
  };
}

/** Pure: a contract JSON's moderation. Never throws. */
export function parseContractModeration(contractJson: unknown): ContractModeration {
  const json = asRecord(contractJson);
  const moderation = asRecord(asRecord(json?.config)?.moderation);
  const createdAtMs = asCount(json?.createdAt);
  const lists = {
    banlist: moderation?.banlist === true,
    suspensions: moderation?.suspensions === true,
    warnings: moderation?.warnings === true,
  };
  const moderators = asRecord(moderation?.moderators);
  let declaration: ModerationDeclaration;
  if (!moderation || !moderators) declaration = { kind: 'none' };
  else if (moderators.$type === 'elected') declaration = { kind: 'elected', elected: parseElected(moderators) };
  else if (moderators.$type === 'contractOwner') declaration = { kind: 'contractOwner' };
  else if (moderators.$type === 'appointedModerators') {
    declaration = { kind: 'appointedModerators', identities: stringList(moderators.identities) };
  } else declaration = { kind: 'unknown', rawType: String(moderators.$type) };
  return { declaration, lists, createdAtMs: createdAtMs || undefined };
}

/** The elected declaration, or undefined when the contract is not elected. */
export function electedOf(m: ContractModeration): ElectedDeclaration | undefined {
  return m.declaration.kind === 'elected' ? m.declaration.elected : undefined;
}

/**
 * When the first charter may apply (`moderation: 'electionOpen'`): the
 * contract's creation plus its election delay. Undefined when there is no
 * delay. A delay on a contract with no recorded creation time never passes
 * (Platform: "a contract created before contracts recorded their creation
 * time never meets a duration"), which is returned as +Infinity.
 */
export function electionOpensAtMs(m: ContractModeration): number | undefined {
  const elected = electedOf(m);
  if (!elected?.electionDelaySeconds) return undefined;
  if (m.createdAtMs === undefined) return Number.POSITIVE_INFINITY;
  return m.createdAtMs + elected.electionDelaySeconds * 1000;
}

/** "1 week", "36 hours", "45 minutes", "0 seconds": windows in words. */
export function durationText(seconds: number): string {
  if (seconds <= 0) return '0 seconds';
  const units: Array<[number, string]> = [
    [7 * 86400, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [size, name] of units) {
    if (seconds % size === 0 || seconds >= size * 2) {
      const n = Math.round((seconds / size) * 10) / 10;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}

export const INTERIM_TEXT: Record<Interim['kind'], string> = {
  contractOwner: 'the contract owner moderates until a team is seated',
  appointedModerators: 'appointed moderators act until a team is seated',
  notYetUsable: 'the moderated document types cannot be used until a team is seated',
  noModeration: 'nobody moderates until a team is seated; every type can be used',
  unknown: 'the interim could not be read',
};
