import { DPNS_CONTRACT_ID } from './dpns';
import { hexToBytes } from './keys';
import type { SdkHandle } from './sdk';

export type VoteChoice =
  | { type: 'identity'; identityId: string }
  | { type: 'abstain' }
  | { type: 'lock' };

/**
 * Sign and broadcast one masternode vote, entirely in the browser.
 *
 * Platform derives the voter identity from ProTxHash + HASH160(voting pubkey)
 * and always assigns it key id 0 (VOTING / HIGH / ECDSA_HASH160, read-only),
 * so the key object can be built locally without fetching the identity first.
 */
export async function castVote(
  handle: SdkHandle,
  args: {
    proTxHash: string;
    wif: string;
    label: string;
    choice: VoteChoice;
  },
): Promise<void> {
  const { sdk, mod } = handle;
  const key = mod.PrivateKey.fromWIF(args.wif);
  const votingKey = new mod.IdentityPublicKey({
    keyId: 0,
    purpose: 'voting',
    securityLevel: 'high',
    keyType: 'ecdsa_hash160',
    isReadOnly: true,
    data: hexToBytes(key.getPublicKeyHash()),
  });
  const signer = new mod.IdentitySigner();
  signer.addKey(key);

  const votePoll = new mod.VotePoll({
    contractId: DPNS_CONTRACT_ID,
    documentTypeName: 'domain',
    indexName: 'parentNameAndLabel',
    indexValues: ['dash', args.label],
  });

  let voteChoice;
  switch (args.choice.type) {
    case 'identity':
      voteChoice = mod.ResourceVoteChoice.TowardsIdentity(args.choice.identityId);
      break;
    case 'abstain':
      voteChoice = mod.ResourceVoteChoice.Abstain();
      break;
    case 'lock':
      voteChoice = mod.ResourceVoteChoice.Lock();
      break;
  }

  await sdk.voting.masternodeVote({
    // Core RPC ProTxHash hex, used as-is (not byte-reversed). Passed as raw
    // bytes: the options deserializer rejects actual Identifier instances
    // despite the declared type (verified against @dashevo/evo-sdk 4.1.1).
    masternodeProTxHash: hexToBytes(args.proTxHash) as unknown as Parameters<
      typeof sdk.voting.masternodeVote
    >[0]['masternodeProTxHash'],
    votePoll,
    voteChoice,
    votingKey,
    signer,
  });
}

// ---- Local vote receipts ---------------------------------------------------
// Purely informational: what *this browser* broadcast, so the UI can remind
// the operator what they did. Platform is the source of truth.

export interface VoteReceipt {
  choice: VoteChoice;
  at: number;
}

type ReceiptMap = Record<string, Record<string, VoteReceipt[]>>;

function receiptsKey(network: string): string {
  return `evovote.votes.${network}`;
}

export function loadReceipts(network: string): ReceiptMap {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(receiptsKey(network)) ?? '{}',
    );
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as ReceiptMap)
      : {};
  } catch {
    return {};
  }
}

export function recordReceipt(
  network: string,
  label: string,
  proTxHash: string,
  choice: VoteChoice,
): void {
  const receipts = loadReceipts(network);
  const byMn = receipts[label] ?? {};
  const list = byMn[proTxHash] ?? [];
  list.push({ choice, at: Date.now() });
  byMn[proTxHash] = list;
  receipts[label] = byMn;
  try {
    localStorage.setItem(receiptsKey(network), JSON.stringify(receipts));
  } catch {
    // Receipts are informational. A storage failure must not make a
    // successfully broadcast vote appear to have failed.
  }
}
