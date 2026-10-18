import { livePollFor } from '../discovery/activePolls';
import { base58Encode, hexToBytes } from '../model/bytes';
import { voteChoicesEqual, type VoteChoice } from '../model/contest';
import { isConstructible, toQueryValue } from '../model/indexValue';
import type { PollKey } from '../model/pollKey';
import type { SdkHandle } from '../sdk/connection';
import { freeQuietly } from '../sdk/free';
import { readCurrentVotes } from './currentVotes';
import type { LoadedKey } from './keyring';

type VotePollInstance = InstanceType<SdkHandle['mod']['VotePoll']>;

/**
 * Whether a vote on this poll can be signed from here: the chain's own poll
 * object is on hand (the open-poll walk saw it), or every index value is one
 * `new VotePoll()` reproduces. Pages gate their vote buttons on this.
 */
export function canVoteOnPoll(key: PollKey, keyString: string): boolean {
  return livePollFor(keyString) !== undefined || key.indexValues.every(isConstructible);
}

/**
 * The VotePoll to sign over. Platform keys a poll (and its contest fund) by
 * a hash of its typed index values, so a poll is rebuilt locally only when
 * every value is one `new VotePoll()` reproduces exactly (text/bool/null:
 * DPNS). Anything else must use the object read from chain by the active
 * poll walk. Throws when neither is possible.
 */
export function votePollFor(
  mod: SdkHandle['mod'],
  key: PollKey,
  keyString: string,
): { poll: VotePollInstance; owned: boolean } {
  const live = livePollFor(keyString);
  if (live) return { poll: live as VotePollInstance, owned: false };
  if (!canVoteOnPoll(key, keyString)) {
    throw new Error(
      'This contest is not in the current list of open polls, so it cannot be voted on from here. Reload the contest and try again.',
    );
  }
  const poll = new mod.VotePoll({
    contractId: key.contractId,
    documentTypeName: key.documentTypeName,
    indexName: key.indexName,
    indexValues: key.indexValues.map(toQueryValue),
  });
  return { poll, owned: true };
}

/**
 * Sign and broadcast one masternode vote in the browser. The voting key is
 * the voter identity's key 0 (VOTING / HIGH / ECDSA_HASH160, read-only),
 * built locally from the hash160 the keyring verified on import.
 *
 * Resolves once Platform recorded the vote (rc.4 `masternodeVote` waits for
 * the block and verifies the proof); callers still confirm with verifyVote.
 */
export async function castVote(
  handle: SdkHandle,
  args: {
    proTxHash: string;
    key: LoadedKey;
    pollKey: PollKey;
    keyString: string;
    choice: VoteChoice;
  },
): Promise<void> {
  const { sdk, mod } = handle;
  // Everything created here is ours to free: the SDK clones option objects.
  const owned: unknown[] = [];
  const own = <T>(obj: T): T => {
    owned.push(obj);
    return obj;
  };
  try {
    const privateKey = own(mod.PrivateKey.fromWIF(args.key.wif));
    const votingKey = own(
      new mod.IdentityPublicKey({
        keyId: 0,
        purpose: 'voting',
        securityLevel: 'high',
        keyType: 'ecdsa_hash160',
        isReadOnly: true,
        data: hexToBytes(args.key.hash160),
      }),
    );
    const signer = own(new mod.IdentitySigner());
    signer.addKey(privateKey);
    const { poll, owned: pollIsOurs } = votePollFor(mod, args.pollKey, args.keyString);
    if (pollIsOurs) own(poll);
    const voteChoice = own(
      args.choice.type === 'identity'
        ? mod.ResourceVoteChoice.TowardsIdentity(args.choice.identityId)
        : args.choice.type === 'abstain'
          ? mod.ResourceVoteChoice.Abstain()
          : mod.ResourceVoteChoice.Lock(),
    );
    const recorded = await sdk.voting.masternodeVote({
      // Base58 of the Core-order bytes: unambiguous, unlike a hex string
      // that could also parse as base58. rc.4 accepts hex, bytes or base58.
      masternodeProTxHash: base58Encode(hexToBytes(args.proTxHash)),
      votePoll: poll,
      voteChoice,
      votingKey,
      signer,
    });
    own(recorded);
  } finally {
    owned.forEach(freeQuietly);
  }
}

/**
 * Confirm a vote by reading the masternode's votes back: the resolved value
 * of masternodeVote is not trusted (it was undefined in older SDKs).
 * Returns true when Platform shows `choice` as the node's current vote.
 */
export async function verifyVote(
  handle: SdkHandle,
  proTxHash: string,
  keyString: string,
  choice: VoteChoice,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 2000;
  for (let i = 0; i < attempts; i++) {
    try {
      const current = (await readCurrentVotes(handle.sdk, proTxHash)).get(keyString);
      if (current && voteChoicesEqual(current, choice)) return true;
    } catch {
      // A failed read is not a verdict; try again.
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
