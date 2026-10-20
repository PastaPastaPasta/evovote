import { discussionContractId, parseContractId } from '../discussion/config';
import type { Network } from '../sdk/network';

/**
 * Build-time settings for "Sign in with Dash Wallet" (App Connect request v2,
 * Yappr's docs/APP_CONNECT_PROFILE.md).
 *
 * The app id is the discussion contract itself: the only EvoVote write a
 * wallet key may sign is a comment, so the one binding the request asks for
 * is `singleContract(discussion contract)`, and the owner rule (every bound
 * contract must share the app id's owner) holds trivially. No extra contract
 * is published for it.
 *
 * `VITE_APP_CONNECT_APP_ID_{TESTNET,MAINNET}` may name another app id (an
 * anchor contract with the same owner, later) or `off` to hide wallet sign-in
 * on a build. Unset means "the discussion contract". Public ids only.
 */
interface AppConnectEnv {
  VITE_DISCUSSION_TESTNET_CONTRACT_ID?: string;
  VITE_DISCUSSION_MAINNET_CONTRACT_ID?: string;
  VITE_APP_CONNECT_APP_ID_TESTNET?: string;
  VITE_APP_CONNECT_APP_ID_MAINNET?: string;
}

export interface AppConnectConfig {
  network: Network;
  /** The id the wallet shows and checks ownership against (base58). */
  appId: string;
  /** The contract the one auth binding is for (base58). */
  discussionContractId: string;
}

/** Platform's App Connect system contract, where wallets publish `loginKeyResponse` documents. */
export const APP_CONNECT_RESPONSE_CONTRACT_ID = 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ';
export const APP_CONNECT_RESPONSE_DOCUMENT_TYPE = 'loginKeyResponse';
/** Bound, limited (V1) keys exist from protocol 14. */
export const APP_CONNECT_MIN_PROTOCOL_VERSION = 14;

/** What the approval sheet calls the app. */
export const APP_CONNECT_LABEL = 'EvoVote';

const DAY_MS = 24 * 60 * 60_000;
/** The comment key: 0.1 DASH (the wallet's lowest preset) for 90 days. */
export const APP_CONNECT_BUDGET = 10_000_000_000n;
export const APP_CONNECT_LIFETIME_MS = 90 * DAY_MS;
/** "Renew soon" below this share of the allowance, under the floor, or with this little time left. */
export const APP_CONNECT_RENEW_BUDGET_SHARE = 0.2;
export const APP_CONNECT_RENEW_BUDGET_FLOOR = 1_000_000_000n;
export const APP_CONNECT_RENEW_WITHIN_MS = 14 * DAY_MS;

export function appConnectConfig(network: Network, env: AppConnectEnv = import.meta.env): AppConnectConfig | null {
  const discussion = discussionContractId(network, env);
  if (!discussion) return null;
  const raw = network === 'mainnet' ? env.VITE_APP_CONNECT_APP_ID_MAINNET : env.VITE_APP_CONNECT_APP_ID_TESTNET;
  if (raw?.trim().toLowerCase() === 'off') return null;
  const appId = raw?.trim() ? parseContractId(raw) : discussion;
  return appId ? { network, appId, discussionContractId: discussion } : null;
}
