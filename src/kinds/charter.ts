import type { EvoSDK } from '@dashevo/evo-sdk';
import { sweepContestedResources } from '../discovery/archive';
import { knownContractById } from '../config/knownContracts';
import { CHARTERS_CONTRACT_ID, splitText, toElectedCharter, type ElectedCharter } from '../charters/documents';
import { CHARTER_INDEX, charterPollKey, charterTarget, proposalHref } from '../charters/pollKey';
import { fetchProposal, fetchReasons } from '../charters/reads';
import { choicesForResolution, type Contender, type Contest, type ContestSummary } from '../model/contest';
import { indexValueFromJs } from '../model/indexValue';
import { freeQuietly } from '../sdk/free';
import { fetchUsernames } from './dpns';
import type { ContenderView, ContestKind } from './types';

export { CHARTERS_CONTRACT_ID, charterPollKey, charterTarget };

const short = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id);

/** "Yappr Social" for a known contract, else its short id. */
export function targetName(targetContractId: string): string {
  return knownContractById(targetContractId)?.name ?? short(targetContractId);
}

export function charterTitle(c: ContestSummary | Contest): string {
  const target = charterTarget(c.key);
  return `Moderators of ${target ? targetName(target) : '?'}`;
}

async function displayName(sdk: EvoSDK, identityId: string): Promise<string> {
  const names = await fetchUsernames(sdk, identityId);
  return names[0] ?? short(identityId);
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
    return toElectedCharter(seated.toJSON(sdk.version()) as Record<string, unknown>);
  } finally {
    freeQuietly(seated);
  }
}

/** Pure part of describeContender: the rows a charter contender shows. */
export function charterContenderFields(args: {
  application?: ElectedCharter;
  memberNames: string[];
  proposal?: { description: string; moderatorsShare: number; rewardSplit?: Parameters<typeof splitText>[0] };
  reasonCodes?: string[];
}): Array<[string, string]> {
  const { application, memberNames, proposal, reasonCodes } = args;
  const rows: Array<[string, string]> = [];
  if (proposal) {
    const text = proposal.description.length > 240 ? `${proposal.description.slice(0, 240)}…` : proposal.description;
    rows.push(['charter', text]);
    rows.push(["moderators' share", `${proposal.moderatorsShare}% of the declared fee`]);
    rows.push(['reward split', splitText(proposal.rewardSplit)]);
  }
  if (reasonCodes) rows.push(['reasons', reasonCodes.length > 0 ? reasonCodes.join(', ') : 'none (the team could take no action)']);
  if (application) {
    rows.push(['members', application.members.length > 0 ? memberNames.join(', ') : 'none besides the leader']);
    if (application.createdAtMs) rows.push(['applied', new Date(application.createdAtMs).toLocaleString()]);
  }
  return rows;
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
  async describeContender(sdk, c, contender) {
    const view: ContenderView = { identityId: contender.identityId, subtitle: 'charter leader' };
    const [leaderName, application] = await Promise.all([
      displayName(sdk, contender.identityId),
      applicationOf(sdk, c, contender).catch(() => undefined),
    ]);
    view.title = leaderName;
    if (!application) return view;
    const [memberNames, proposal] = await Promise.all([
      Promise.all(application.members.map((m) => displayName(sdk, m))),
      fetchProposal(sdk, application.submittedCharterId).catch(() => undefined),
    ]);
    const reasons = proposal
      ? await fetchReasons(sdk, proposal.reasonIds).catch(() => undefined)
      : undefined;
    view.fields = charterContenderFields({
      application,
      memberNames,
      proposal,
      reasonCodes: reasons?.reasons.map((r) => `${r.code} ${r.label}`),
    });
    const target = charterTarget(c.key);
    if (target) view.link = { href: proposalHref(target, application.submittedCharterId), label: 'Open the proposal' };
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
