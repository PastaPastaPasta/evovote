import { utf8Length } from '../model/bytes';
import type { RewardSplit } from './documents';

/**
 * Client-side checks that mirror the charters contract schema
 * (packages/moderation-charters-contract/schema/v1), so a write the chain
 * would refuse (and still charge for) is caught before anything is signed.
 * Each returns a list of plain-language problems; empty means valid.
 */

const REASON_CODE = /^[A-Z]{3}$/;
export const MAX_REASON_LABEL = 64;
export const MAX_REASON_DESCRIPTION = 1024;
const MAX_CHARTER_DESCRIPTION_BYTES = 4096;
const MAX_CHARTER_REASONS = 64;
/** `electedCharter.members.maxItems`: the team besides the leader. */
export const MAX_ELECTED_MEMBERS = 15;
export const MAX_JOIN_MESSAGE_BYTES = 1023;

export interface ReasonInput {
  code: string;
  label: string;
  description?: string;
}

export function validateReason(input: ReasonInput, existingCodes: readonly string[] = []): string[] {
  const problems: string[] = [];
  if (!REASON_CODE.test(input.code)) problems.push('The code must be exactly three capital letters, like SPM.');
  else if (existingCodes.includes(input.code)) {
    problems.push(`You already filed a reason with code ${input.code}; reuse it instead (codes are unique per identity).`);
  }
  const label = input.label.trim();
  if (label.length < 1 || label.length > MAX_REASON_LABEL) {
    problems.push(`The label must be 1 to ${MAX_REASON_LABEL} characters.`);
  }
  const description = input.description?.trim() ?? '';
  if (description.length > MAX_REASON_DESCRIPTION) {
    problems.push(`The description must be at most ${MAX_REASON_DESCRIPTION} characters.`);
  }
  return problems;
}

export interface CharterInput {
  description: string;
  reasonIds: readonly string[];
  /** 0 to 100; undefined files no share (the full declared fee). */
  moderatorsShare?: number;
  rewardSplit: RewardSplit;
}

export function validateRewardSplit(split: RewardSplit): string[] {
  const problems: string[] = [];
  const parts = [split.leader, split.equal, split.actions];
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 100)) {
    problems.push('Each part of the reward split must be a whole number from 0 to 100.');
  } else if (parts.reduce((a, b) => a + b, 0) !== 100) {
    problems.push(
      `The reward split must add up to 100 (it adds up to ${parts.reduce((a, b) => a + b, 0)}). Platform refuses any other split (10422).`,
    );
  }
  return problems;
}

export function validateCharter(input: CharterInput): string[] {
  const problems: string[] = [];
  const bytes = utf8Length(input.description.trim());
  if (bytes < 1) problems.push('Describe what the team would moderate and how.');
  else if (bytes > MAX_CHARTER_DESCRIPTION_BYTES) {
    problems.push(`The description is ${bytes} bytes; the limit is ${MAX_CHARTER_DESCRIPTION_BYTES}.`);
  }
  if (input.reasonIds.length > MAX_CHARTER_REASONS) {
    problems.push(`A charter can list at most ${MAX_CHARTER_REASONS} reasons.`);
  }
  if (new Set(input.reasonIds).size !== input.reasonIds.length) problems.push('A reason is listed twice.');
  if (input.moderatorsShare !== undefined) {
    const s = input.moderatorsShare;
    if (!Number.isInteger(s) || s < 0 || s > 100) {
      problems.push("The moderators' share must be a whole number from 0 to 100.");
    }
  }
  problems.push(...validateRewardSplit(input.rewardSplit));
  return problems;
}

/**
 * Notes (not errors) on a split given the team actually chosen: with no
 * other members, the equal share goes to the leader.
 */
export function splitNotes(split: RewardSplit | undefined, memberCount: number): string[] {
  if (split && memberCount === 0 && split.equal > 0) {
    return [`With no members, the ${split.equal}% equal share of every claim goes to the leader.`];
  }
  return [];
}

/** Notes on what a share means, for the confirm step. */
export function shareNote(share: number | undefined): string | undefined {
  if (share === undefined || share === 100) return undefined;
  if (share === 0) return 'A share of 0 means the team takes no moderators fees at all.';
  return `The team takes ${share}% of each declared moderators fee; actions may agree to that discount once the team is seated.`;
}

interface MembersInput {
  leaderId: string;
  members: readonly string[];
  /** Identities that filed a join request for this proposal. */
  joiners: ReadonlySet<string>;
}

export function validateMembers({ leaderId, members, joiners }: MembersInput): string[] {
  const problems: string[] = [];
  if (members.length > MAX_ELECTED_MEMBERS) {
    problems.push(`A team can elect at most ${MAX_ELECTED_MEMBERS} members besides the leader.`);
  }
  if (new Set(members).size !== members.length) problems.push('A member is listed twice.');
  if (members.includes(leaderId)) problems.push('The leader cannot also be a member.');
  const strangers = members.filter((m) => m !== leaderId && !joiners.has(m));
  if (strangers.length > 0) {
    problems.push(
      `${strangers.length} member(s) have not asked to join this proposal; Platform refuses them (40120).`,
    );
  }
  return problems;
}

export function validateJoinMessage(message: string): string[] {
  const bytes = utf8Length(message);
  if (bytes < 1) return ['Write a short message to the leader.'];
  if (bytes > MAX_JOIN_MESSAGE_BYTES) {
    return [`The message is ${bytes} bytes; the limit is ${MAX_JOIN_MESSAGE_BYTES}.`];
  }
  return [];
}
