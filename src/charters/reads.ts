import type { EvoSDK } from '@dashevo/evo-sdk';
import { getActivePolls } from '../discovery/activePolls';
import { fetchContract } from '../discovery/contracts';
import type { Failure } from '../discovery/types';
import { fetchContest } from '../discovery/voteState';
import { charterPollKey } from './pollKey';
import { isEmptyContest, type Contest } from '../model/contest';
import { encodePollKey } from '../model/pollKey';
import { errorMessage } from '../sdk/errors';
import { freeQuietly } from '../sdk/free';
import { isBoundKey, keyInfoFrom } from '../identity/keys';
import { parseContractModeration, type ContractModeration } from './declaration';
import {
  CHARTERS_CONTRACT_ID,
  toJoinRequestMeta,
  toProposal,
  toReason,
  type CharterProposal,
  type CharterReason,
  type JoinRequestMeta,
} from './documents';
import { electionTiming, type ElectionTiming, type Read } from './phase';

/**
 * Reads of the moderation charters contract (`sdk.moderationCharters`) and
 * of a target contract's declaration. Every aggregate carries `failures`:
 * a read that failed is reported, never shown as "none".
 */

/** Pages of 100, up to this many items, before a read stops and says so. */
export const CHARTER_PAGE = 100;
export const MAX_PROPOSALS = 500;
export const MAX_JOIN_REQUESTS = 500;

interface DocLike {
  toJSON(version: unknown): unknown;
  free?: () => void;
}

/**
 * Map a page of documents through `map`, freeing every one of them even
 * when a mapping throws (the first error is rethrown afterwards).
 */
function mapDocs<T>(
  sdk: EvoSDK,
  docs: Iterable<[string, unknown]>,
  map: (json: Record<string, unknown>, id: string) => T,
): T[] {
  const version = sdk.version();
  const out: T[] = [];
  let failure: unknown;
  for (const [id, raw] of docs) {
    const doc = raw as DocLike | undefined;
    if (!doc) continue;
    try {
      if (failure === undefined) out.push(map(doc.toJSON(version) as Record<string, unknown>, id));
    } catch (e) {
      failure = e;
    } finally {
      freeQuietly(doc);
    }
  }
  if (failure !== undefined) throw failure;
  return out;
}

/** Query documents of the charters contract page by page, up to `max`. */
async function queryAll<T>(
  sdk: EvoSDK,
  query: Omit<Parameters<EvoSDK['documents']['query']>[0], 'limit' | 'startAfter'>,
  map: (json: Record<string, unknown>, id: string) => T,
  max: number,
): Promise<{ items: T[]; capped: boolean }> {
  const items: T[] = [];
  let startAfter: string | undefined;
  while (items.length < max) {
    const page = await sdk.documents.query({ ...query, limit: CHARTER_PAGE, ...(startAfter ? { startAfter } : {}) });
    items.push(...mapDocs(sdk, page, map));
    if (page.size < CHARTER_PAGE) return { items, capped: false };
    startAfter = [...page.keys()].pop();
    if (!startAfter) break;
  }
  return { items: items.slice(0, max), capped: true };
}

/** A contract's moderation, or undefined when the contract does not exist. Throws when the read fails. */
export async function fetchModeration(sdk: EvoSDK, contractId: string): Promise<ContractModeration | undefined> {
  const contract = await fetchContract(sdk, contractId);
  if (!contract) return undefined;
  return parseContractModeration(contract.toJSON(sdk.version()));
}

export interface TeamView {
  electedCharterId: string;
  submittedCharterId: string;
  leaderId: string;
  /** Members besides the leader, as the team is now. */
  members: string[];
  /** The members the election seated (a removed one keeps its seat). */
  electedMembers: string[];
}

/** The seated team, or undefined when no charter is seated. Throws when the read fails. */
export async function fetchTeam(sdk: EvoSDK, targetContractId: string): Promise<TeamView | undefined> {
  const team = await sdk.moderationCharters.team(targetContractId);
  if (!team) return undefined;
  const ids = (list: Array<{ toBase58(): string }>) =>
    list.map((id) => {
      try {
        return id.toBase58();
      } finally {
        freeQuietly(id);
      }
    });
  try {
    return {
      electedCharterId: team.electedCharterId.toBase58(),
      submittedCharterId: team.submittedCharterId.toBase58(),
      leaderId: team.leaderId.toBase58(),
      members: ids(team.members),
      electedMembers: ids(team.electedMembers),
    };
  } finally {
    freeQuietly(team);
  }
}

/** Every proposal for a target, in filing order, up to `max`. Throws when a page fails. */
export async function fetchProposals(
  sdk: EvoSDK,
  targetContractId: string,
  max = MAX_PROPOSALS,
): Promise<{ proposals: CharterProposal[]; capped: boolean }> {
  const proposals: CharterProposal[] = [];
  let startAfter: string | undefined;
  while (proposals.length < max) {
    const page = await sdk.moderationCharters.submittedCharters({
      targetContractId,
      limit: CHARTER_PAGE,
      ...(startAfter ? { startAfter } : {}),
    });
    const docs = mapDocs(sdk, page, (json, id) => toProposal(json, id));
    proposals.push(...docs);
    if (page.size < CHARTER_PAGE) return { proposals, capped: false };
    startAfter = [...page.keys()].pop();
    if (!startAfter) break;
  }
  return { proposals: proposals.slice(0, max), capped: true };
}

export async function fetchProposal(sdk: EvoSDK, submittedCharterId: string): Promise<CharterProposal | undefined> {
  const doc = await sdk.moderationCharters.submittedCharter(submittedCharterId);
  if (!doc) return undefined;
  try {
    return toProposal(doc.toJSON(sdk.version()) as Record<string, unknown>, submittedCharterId);
  } finally {
    freeQuietly(doc);
  }
}

/**
 * The reasons a proposal lists, in its order. A listed reason that does not
 * exist is returned in `missing`; a read failure throws.
 */
export async function fetchReasons(
  sdk: EvoSDK,
  reasonIds: readonly string[],
): Promise<{ reasons: CharterReason[]; missing: string[] }> {
  const docs = await Promise.all(
    reasonIds.map((id) => sdk.documents.get(CHARTERS_CONTRACT_ID, 'reason', id)),
  );
  const missing = reasonIds.filter((_, i) => !docs[i]);
  const reasons = mapDocs(
    sdk,
    docs.map((doc, i): [string, unknown] => [reasonIds[i], doc]),
    (json, id) => toReason(json, id),
  );
  return { reasons, missing };
}

/** The reasons an identity has filed (for reuse), by code, up to 500. Throws when the read fails. */
export async function fetchReasonsByOwner(sdk: EvoSDK, ownerId: string): Promise<{ reasons: CharterReason[]; capped: boolean }> {
  const { items, capped } = await queryAll(
    sdk,
    {
      dataContractId: CHARTERS_CONTRACT_ID,
      documentTypeName: 'reason',
      where: [['$ownerId', '==', ownerId]],
      orderBy: [
        ['$ownerId', 'asc'],
        ['code', 'asc'],
      ],
    },
    (json, id) => toReason(json, id),
    500,
  );
  return { reasons: items, capped };
}

/** The proposals an identity leads, up to 500. Throws when the read fails. */
export async function fetchProposalsByLeader(sdk: EvoSDK, leaderId: string): Promise<CharterProposal[]> {
  const { items } = await queryAll(
    sdk,
    {
      dataContractId: CHARTERS_CONTRACT_ID,
      documentTypeName: 'submittedCharter',
      where: [['$ownerId', '==', leaderId]],
      orderBy: [['$ownerId', 'asc']],
    },
    (json, id) => toProposal(json, id),
    500,
  );
  return items;
}

/**
 * Walk a proposal's join requests page by page, handing each wasm document
 * to `visit` (which must not keep it: it is freed after the call).
 */
export async function forEachJoinRequest(
  sdk: EvoSDK,
  submittedCharterId: string,
  visit: (doc: unknown, id: string) => Promise<void> | void,
  max = MAX_JOIN_REQUESTS,
): Promise<{ count: number; capped: boolean }> {
  let count = 0;
  let startAfter: string | undefined;
  while (count < max) {
    const page = await sdk.moderationCharters.joinRequests({
      submittedCharterId,
      limit: CHARTER_PAGE,
      ...(startAfter ? { startAfter } : {}),
    });
    for (const [id, doc] of page) {
      try {
        if (doc && count < max) {
          count++;
          await visit(doc, id);
        }
      } finally {
        freeQuietly(doc);
      }
    }
    if (page.size < CHARTER_PAGE) return { count, capped: false };
    startAfter = [...page.keys()].pop();
    if (!startAfter) break;
  }
  return { count, capped: true };
}

/** Who asked to join a proposal and when: metadata only, never the messages. */
export async function fetchJoinRequests(
  sdk: EvoSDK,
  submittedCharterId: string,
): Promise<{ requests: JoinRequestMeta[]; capped: boolean }> {
  const requests: JoinRequestMeta[] = [];
  const version = sdk.version();
  const { capped } = await forEachJoinRequest(sdk, submittedCharterId, (doc, id) => {
    requests.push(toJoinRequestMeta((doc as DocLike).toJSON(version) as Record<string, unknown>, id));
  });
  return { requests, capped };
}

/** Whether a leader holds a decryption key bound to `submittedCharter` (joins need it). Throws when the read fails. */
export async function leaderCanReceive(sdk: EvoSDK, leaderId: string): Promise<boolean> {
  const identity = await sdk.identities.fetch(leaderId);
  if (!identity) return false;
  try {
    const keys = identity.publicKeys.map((k) => {
      try {
        return keyInfoFrom(k);
      } finally {
        freeQuietly(k);
      }
    });
    return keys.some((k) => isBoundKey(k, 'DECRYPTION', CHARTERS_CONTRACT_ID, 'submittedCharter'));
  } finally {
    freeQuietly(identity);
  }
}

/** The contest for a target's seat, or undefined when nobody applied. Throws when the read fails. */
export async function fetchCharterContest(
  sdk: EvoSDK,
  targetContractId: string,
  force = false,
): Promise<Contest | undefined> {
  const key = charterPollKey(targetContractId);
  const contest = await fetchContest(sdk, { key, keyString: encodePollKey(key) }, force);
  return isEmptyContest(contest) ? undefined : contest;
}

/** The contest's end from the end-date index; undefined when it is not there. */
export async function fetchCharterContestEnd(
  sdk: EvoSDK,
  targetContractId: string,
  force = false,
): Promise<{ endsAtMs?: number; failures: Failure[] }> {
  const keyString = encodePollKey(charterPollKey(targetContractId));
  // Forced with the contest: an end cached from before a second applicant
  // joined, paired with the fresh contender count, would misplace the join close.
  const active = await getActivePolls(sdk, force);
  const endsAtMs = active.polls.find((p) => p.keyString === keyString)?.endsAtMs;
  const failures = [...active.failures];
  if (endsAtMs === undefined && active.caps.length > 0) {
    failures.push({ source: 'active polls', message: 'the end-date walk stopped at its cap before finding this contest' });
  }
  return { endsAtMs, failures };
}

/** The earliest application's time, from the contenders' documents. */
export function firstAppliedAt(contest: Contest | undefined): number | undefined {
  const times = (contest?.tally.contenders ?? [])
    .map((c) => Number(c.document?.$createdAt))
    .filter((t) => Number.isFinite(t) && t > 0);
  return times.length > 0 ? Math.min(...times) : undefined;
}

export interface ElectionStatus {
  targetContractId: string;
  /** Undefined: the contract was not found, or its read failed (see failures). */
  moderation?: ContractModeration;
  /** False when the contract does not exist; undefined when that could not be read. */
  contractFound?: boolean;
  team?: TeamView;
  contest?: Contest;
  proposals: CharterProposal[];
  proposalsCapped: boolean;
  timing: ElectionTiming;
  failures: Failure[];
}

/** Everything the election hub shows for one target. Never throws. */
export async function fetchElectionStatus(
  sdk: EvoSDK,
  targetContractId: string,
  opts: { force?: boolean; now?: number } = {},
): Promise<ElectionStatus> {
  const failures: Failure[] = [];
  const attempt = <T>(source: string, read: Promise<T>): Promise<Read<T>> =>
    read.catch((e: unknown) => {
      failures.push({ source, message: errorMessage(e) });
      return 'failed' as const;
    });

  const [moderation, team, contest, proposals, end] = await Promise.all([
    attempt('the contract declaration', fetchModeration(sdk, targetContractId)),
    attempt('the seated team', fetchTeam(sdk, targetContractId)),
    attempt('the contest for the seat', fetchCharterContest(sdk, targetContractId, opts.force)),
    attempt('the filed proposals', fetchProposals(sdk, targetContractId)),
    attempt('when voting ends', fetchCharterContestEnd(sdk, targetContractId, opts.force)),
  ]);
  if (end !== 'failed') failures.push(...end.failures.map((f) => ({ ...f, source: 'when voting ends' })));

  const timing = electionTiming(
    {
      moderation,
      seated: team === 'failed' ? 'failed' : team !== undefined,
      contest:
        contest === 'failed'
          ? 'failed'
          : contest && { contenders: contest.tally.contenders.length, hasWinner: !!contest.winner },
      endsAtMs: end === 'failed' ? undefined : end.endsAtMs,
      firstAppliedAtMs: contest === 'failed' ? undefined : firstAppliedAt(contest),
      proposals: proposals === 'failed' ? 'failed' : proposals.proposals.length,
    },
    opts.now,
  );

  return {
    targetContractId,
    moderation: moderation === 'failed' ? undefined : moderation,
    contractFound: moderation === 'failed' ? undefined : moderation !== undefined,
    team: team === 'failed' ? undefined : team,
    contest:
      contest === 'failed' || !contest
        ? undefined
        : { ...contest, endsAtMs: end === 'failed' ? contest.endsAtMs : (end.endsAtMs ?? contest.endsAtMs) },
    proposals: proposals === 'failed' ? [] : proposals.proposals,
    proposalsCapped: proposals !== 'failed' && proposals.capped,
    timing,
    failures,
  };
}
