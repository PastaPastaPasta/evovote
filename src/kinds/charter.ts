import type { EvoSDK } from '@dashevo/evo-sdk';
import { sweepContestedResources } from '../discovery/archive';
import { contractJson, fetchContract } from '../discovery/contracts';
import { knownContractById } from '../config/knownContracts';
import {
  CHARTERS_CONTRACT_ID,
  toElectedCharter,
  type CharterProposal,
  type ElectedCharter,
} from '../charters/documents';
import { CHARTER_INDEX, charterPollKey, charterTarget, proposalHref } from '../charters/pollKey';
import { fetchLeaderProposal, fetchProposal, fetchReasons } from '../charters/reads';
import { choicesForResolution, type Contender, type Contest, type ContestSummary } from '../model/contest';
import { indexValueFromJs } from '../model/indexValue';
import { shortId } from '../model/text';
import { freeQuietly } from '../sdk/free';
import { fetchUsernames } from './dpns';
import type { CharterApplicationView, ContenderView, ContestKind } from './types';

export { CHARTERS_CONTRACT_ID, charterPollKey };

/** The owner's first DPNS name of each contract the site has no name for, once read ('' when they have none). */
const ownerNames = new Map<string, string>();

/**
 * A contract's name, the same on every page: the site's name for a known
 * contract ("Yappr Social"), else its owner's ("alice.dash's contract") once
 * `resolveTargetName` has read it, else "contract EFyPZP…CW8zAt".
 */
export function targetName(targetContractId: string): string {
  const known = knownContractById(targetContractId)?.name;
  if (known) return known;
  const owner = ownerNames.get(targetContractId);
  return owner ? `${owner}'s contract` : `contract ${shortId(targetContractId)}`;
}

/** `targetName` heading a page or card: "Contract EFyPZP…CW8zAt" (a DPNS name keeps its own case). */
export function targetTitle(targetContractId: string): string {
  const name = targetName(targetContractId);
  return name.startsWith('contract ') ? `C${name.slice(1)}` : name;
}

/** `targetName` after reading (once) the owner of a contract the site has no name for. Never throws. */
export async function resolveTargetName(sdk: EvoSDK, targetContractId: string): Promise<string> {
  if (knownContractById(targetContractId) || ownerNames.has(targetContractId)) return targetName(targetContractId);
  try {
    const contract = await fetchContract(sdk, targetContractId);
    const owner = contract && (contractJson(sdk, contract) as { ownerId?: unknown }).ownerId;
    if (contract) {
      const name = typeof owner === 'string' ? (await fetchUsernames(sdk, owner))[0] : undefined;
      ownerNames.set(targetContractId, name ?? '');
    }
  } catch {
    // Best effort: the short id names it.
  }
  return targetName(targetContractId);
}

export function charterTitle(c: ContestSummary | Contest): string {
  const target = charterTarget(c.key);
  return `Moderators of ${target ? targetName(target) : '?'}`;
}

async function displayName(sdk: EvoSDK, identityId: string): Promise<string> {
  const names = await fetchUsernames(sdk, identityId);
  return names[0] ?? shortId(identityId);
}

/**
 * The contender's application. While the contest runs, the vote state
 * carries it; once decided it does not, and the winner's is the seated
 * charter.
 */
async function applicationOf(
  sdk: EvoSDK,
  c: Contest,
  contender: Contender,
): Promise<ElectedCharter | undefined> {
  if (contender.document) return toElectedCharter(contender.document);
  const target = charterTarget(c.key);
  if (!target || c.winner?.identityId !== contender.identityId) return undefined;
  const seated = await sdk.moderationCharters.seatedCharter(target);
  if (!seated) return undefined;
  try {
    const charter = toElectedCharter(seated.toJSON(sdk.version()) as Record<string, unknown>);
    // The seat may have changed hands since this contest: only the winner's own counts.
    return charter.leaderId === contender.identityId ? charter : undefined;
  } finally {
    freeQuietly(seated);
  }
}

/** Pure part of describeContender: a charter contender's card, from what was read. */
export function charterApplicationView(args: {
  target: string;
  proposal: CharterProposal;
  /** Undefined when the reasons could not be read. */
  reasons?: Array<{ code: string; label: string }>;
  /** Listed reasons that no longer exist. */
  missingReasons?: number;
  /** The electedCharter, when it is still there (open contests, the winner). */
  application?: ElectedCharter;
  memberNames?: string[];
  /** Proposals the pick was made from (no application to name the one). */
  candidates?: number;
}): CharterApplicationView {
  const { target, proposal, reasons, missingReasons = 0, application, memberNames, candidates = 1 } = args;
  return {
    description: proposal.description,
    moderatorsShare: proposal.moderatorsShare,
    rewardSplit: proposal.rewardSplit,
    reasons,
    missingReasons,
    ...(!application && candidates > 1 ? { guessedFrom: candidates } : {}),
    members: application ? (memberNames ?? application.members.map((m) => shortId(m))) : undefined,
    appliedAtMs: application?.createdAtMs,
    href: proposalHref(target, proposal.id),
  };
}

/**
 * Moderator elections (`electedCharter.byTargetContract`, resolution 1):
 * the contest for one contract's moderation seat. Each contender is a
 * charter's leader.
 */
export const charterKind: ContestKind = {
  id: 'charter',
  label: 'Moderator elections',
  matches: (key) => charterTarget(key) !== undefined,
  title: charterTitle,
  /**
   * The charter the contender stands on. A decided contest keeps only the
   * winner's application (as the seated charter); a loser's is found among
   * the proposals they filed for this target. Throws when a read fails, so
   * "no charter" is only said when none exists.
   */
  async describeContender(sdk, c, contender) {
    const view: ContenderView = { identityId: contender.identityId };
    const target = charterTarget(c.key);
    if (!target) return view;
    const application = await applicationOf(sdk, c, contender);
    let proposal: CharterProposal | undefined;
    let candidates = 1;
    if (application) {
      proposal = await fetchProposal(sdk, application.submittedCharterId);
      if (!proposal) {
        view.charter = null;
        view.subtitle = 'Its proposal no longer exists.';
        return view;
      }
    } else {
      // Only a decided contest drops applications. An open one without its
      // document could not be read; guessing from proposals would mislead.
      const decidedAtMs = c.winner?.decidedAtMs;
      if (decidedAtMs === undefined) throw new Error('the application could not be read');
      ({ proposal, candidates } = await fetchLeaderProposal(sdk, contender.identityId, target, decidedAtMs));
    }
    if (!proposal || proposal.targetContractId !== target || proposal.leaderId !== contender.identityId) {
      view.charter = null;
      return view;
    }
    const [memberNames, reasons] = await Promise.all([
      application ? Promise.all(application.members.map((m) => displayName(sdk, m))) : undefined,
      fetchReasons(sdk, proposal.reasonIds).catch(() => undefined),
    ]);
    view.charter = charterApplicationView({
      target,
      proposal,
      reasons: reasons?.reasons.map(({ code, label }) => ({ code, label })),
      missingReasons: reasons?.missing.length ?? 0,
      application,
      memberNames,
      candidates,
    });
    return view;
  },
  // Resolution 1: no Lock. There is always a winner; ties go to the earliest contender.
  choices: () => choicesForResolution(1),
  archive: (sdk) =>
    sweepContestedResources(sdk, {
      source: 'moderator election archive',
      contractId: CHARTERS_CONTRACT_ID,
      ...CHARTER_INDEX,
      prefix: [],
      toKey: (resource) => {
        const target = indexValueFromJs(resource, 'identifier');
        return target?.type === 'identifier' ? charterPollKey(target.value) : undefined;
      },
    }),
};
