import type { VoteChoice } from '../model/contest';
import type { Network } from '../sdk/network';

// Local vote receipts: what *this browser* broadcast, keyed by PollKey string
// then ProTxHash. Informational only (Platform is the source of truth), but
// they are the only record of how many of a node's 5 votes per poll were
// spent: the identity-votes query returns the current vote, not the count.

export interface VoteReceipt {
  choice: VoteChoice;
  at: number;
  /** True once the vote was read back from Platform. */
  verified: boolean;
}

type ReceiptMap = Record<string, Record<string, VoteReceipt[]>>;

const storageKey = (network: Network) => `evovote.v2.receipts.${network}`;

export function loadReceipts(network: Network): ReceiptMap {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(network)) ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as ReceiptMap) : {};
  } catch {
    return {};
  }
}

export function receiptsFor(
  network: Network,
  keyString: string,
  proTxHash: string,
): VoteReceipt[] {
  return loadReceipts(network)[keyString]?.[proTxHash] ?? [];
}

export function recordReceipt(
  network: Network,
  keyString: string,
  proTxHash: string,
  receipt: VoteReceipt,
): void {
  const receipts = loadReceipts(network);
  const byMn = receipts[keyString] ?? {};
  byMn[proTxHash] = [...(byMn[proTxHash] ?? []), receipt];
  receipts[keyString] = byMn;
  try {
    localStorage.setItem(storageKey(network), JSON.stringify(receipts));
  } catch {
    // Storage full or disabled: receipts are best effort.
  }
}
