import { isBase58Identifier } from '../model/bytes';
import type { Network } from '../sdk/network';

/**
 * The published discussion contract per network, from the build environment
 * (`VITE_DISCUSSION_{TESTNET,MAINNET}_CONTRACT_ID`, set from repository
 * variables in the deploy workflow). Public ids only.
 *
 * A missing or malformed id means "discussion is not activated on this
 * network": the UI says so and nothing is read or written. It is not an error.
 */
interface DiscussionEnv {
  VITE_DISCUSSION_TESTNET_CONTRACT_ID?: string;
  VITE_DISCUSSION_MAINNET_CONTRACT_ID?: string;
}

/** A configured id, or undefined when it is empty or not a Platform identifier. */
export function parseContractId(raw: string | undefined): string | undefined {
  const id = raw?.trim();
  return id && isBase58Identifier(id) ? id : undefined;
}

export function discussionContractId(
  network: Network,
  env: DiscussionEnv = import.meta.env,
): string | undefined {
  return parseContractId(
    network === 'mainnet' ? env.VITE_DISCUSSION_MAINNET_CONTRACT_ID : env.VITE_DISCUSSION_TESTNET_CONTRACT_ID,
  );
}
