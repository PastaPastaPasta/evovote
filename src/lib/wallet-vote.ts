import { sha256 } from '@noble/hashes/sha2.js';
import { base58Decode, base58Encode, hexToBytes, isProTxHash } from './keys';
import { DPNS_CONTRACT_ID } from './dpns';
import type { Network, SdkHandle } from './sdk';
import type { VoteChoice } from './vote';

export function votingAddressHash(address: string, network: Network): Uint8Array {
  const bytes = base58Decode(address.trim());
  const version = network === 'mainnet' ? 0x4c : 0x8c;
  if (bytes.length !== 25 || bytes[0] !== version) throw new Error('Enter a voting address for the selected network.');
  const checksum = sha256(sha256(bytes.slice(0, 21))).slice(0, 4);
  if (!checksum.every((byte, index) => byte === bytes[index + 21])) throw new Error('The voting address checksum is invalid.');
  return bytes.slice(1, 21);
}

export function voterIdentityId(proTxHash: string, votingHash: Uint8Array): string {
  if (!isProTxHash(proTxHash) || votingHash.length !== 20) throw new Error('Invalid masternode voting information.');
  // Matches DPP Identifier::create_voter_identifier: Core ProTxHash bytes as-is.
  const bytes = new Uint8Array(52);
  bytes.set(hexToBytes(proTxHash), 0); bytes.set(votingHash, 32);
  return base58Encode(sha256(bytes));
}

export interface PreparedVote {
  bytes: Uint8Array;
  voterId: string;
  nonce: bigint;
  label: string;
  choice: VoteChoice;
}

export async function prepareWalletVote(handle: SdkHandle, network: Network, proTxHash: string,
  votingAddress: string, label: string, choice: VoteChoice): Promise<PreparedVote> {
  const hash = votingAddressHash(votingAddress, network);
  const voterId = voterIdentityId(proTxHash, hash);
  const identity = await handle.sdk.identities.fetch(voterId);
  if (!identity) throw new Error('No voter identity matches this ProTxHash and voting address. Check protx info.');
  const keys = identity.publicKeys;
  try {
    const key = keys.find(key => key.keyId === 0 && key.purposeNumber === 5 && key.disabledAt == null);
    if (!key || key.getPublicKeyHash() !== Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')) {
      throw new Error('The voting key is not active on this identity.');
    }
  } finally { keys.forEach(key => key.free()); identity.free(); }
  const nonce = (await handle.sdk.identities.nonce(voterId) ?? 0n) + 1n;
  const { mod } = handle;
  const resources: { free(): void }[] = [];
  try {
    const poll = new mod.VotePoll({ contractId: DPNS_CONTRACT_ID, documentTypeName: 'domain',
      indexName: 'parentNameAndLabel', indexValues: ['dash', label] });
    resources.push(poll);
    const selected = choice.type === 'identity' ? mod.ResourceVoteChoice.TowardsIdentity(choice.identityId)
      : choice.type === 'lock' ? mod.ResourceVoteChoice.Lock() : mod.ResourceVoteChoice.Abstain();
    resources.push(selected);
    const vote = new mod.Vote(poll, selected); resources.push(vote);
    const transition = new mod.MasternodeVoteTransition({ proTxHash: hexToBytes(proTxHash), voterIdentityId: voterId,
      vote, nonce, signaturePublicKeyId: 0 });
    resources.push(transition);
    const state = transition.toStateTransition(); resources.push(state);
    return { bytes: state.toBytes(), voterId, nonce, label, choice };
  } finally { resources.reverse().forEach(resource => resource.free()); }
}

/** Verifies current state, not execution of a particular unsigned request. */
export async function walletVoteMatches(handle: SdkHandle, prepared: PreparedVote): Promise<boolean> {
  const nonce = await handle.sdk.identities.nonce(prepared.voterId);
  if (nonce == null || nonce < prepared.nonce) return false;
  const expectedPoll = new handle.mod.VotePoll({ contractId: DPNS_CONTRACT_ID, documentTypeName: 'domain',
    indexName: 'parentNameAndLabel', indexValues: ['dash', prepared.label] });
  const expectedPollJson = JSON.stringify(expectedPoll.toJSON());
  expectedPoll.free();
  let startAtVoteId: string | undefined;
  for (let page = 0; page < 20; page++) {
    const votes = await handle.sdk.voting.contestedResourceIdentityVotes({ identityId: prepared.voterId,
      limit: 100, ...(startAtVoteId ? { startAtVoteId, startAtIncluded: false } : {}) });
    let matches = false;
    for (const vote of votes.values()) {
      const poll = vote.poll;
      const choice = vote.choice;
      try {
        if (JSON.stringify(poll.toJSON()) === expectedPollJson) {
          matches = prepared.choice.type === 'identity' ? choice.value?.toString() === prepared.choice.identityId
            : choice.voteType.toLowerCase() === prepared.choice.type;
        }
      } finally { poll.free(); choice.free(); vote.free(); }
    }
    if (matches) return true;
    if (votes.size < 100) return false;
    startAtVoteId = Array.from(votes.keys()).at(-1);
  }
  throw new Error('This identity has too many votes to verify here. Check its current vote in a Platform explorer.');
}
