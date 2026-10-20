import { base58Decode } from '../model/bytes';
import { KeySecurityLevel, type AppConnectRequest } from './protocol';
import { APP_CONNECT_BUDGET, APP_CONNECT_LABEL, APP_CONNECT_LIFETIME_MS, type AppConnectConfig } from './config';

export interface EvoVoteRequestInput {
  config: AppConnectConfig;
  appEphemeralPubKey: Uint8Array;
  /** 16 bytes, per browser and network, kept across sign-outs. */
  connectionId: Uint8Array;
  createdAt: number;
  /** Renewal: only this identity may answer. */
  identityHint?: string;
}

/**
 * EvoVote's request: one HIGH key bound to the discussion contract, with a
 * 0.1 DASH allowance for 90 days. No encryption binding (nothing EvoVote
 * encrypts lives on a contract it owns) and no group.
 */
export function buildEvoVoteRequest(input: EvoVoteRequestInput): AppConnectRequest {
  const { config, createdAt } = input;
  return {
    appEphemeralPubKey: input.appEphemeralPubKey,
    appId: base58Decode(config.appId),
    label: APP_CONNECT_LABEL,
    authBindings: [
      {
        kind: 'singleContract',
        id: base58Decode(config.discussionContractId),
        securityLevel: KeySecurityLevel.HIGH,
        totalBudget: APP_CONNECT_BUDGET,
        expiresAt: createdAt + APP_CONNECT_LIFETIME_MS,
      },
    ],
    encBindings: [],
    createdAt,
    connectionId: input.connectionId,
    ...(input.identityHint ? { identityHint: base58Decode(input.identityHint) } : {}),
  };
}

/** The query parameter the wallet's return link carries the request hash in. */
export const CALLBACK_REQUEST_PARAM = 'ac_r';

/**
 * The wallet's return link: this page with the request hash, keeping only
 * `?network=` (no fragment: EvoVote routes by hash, and the wallet appends
 * `&ac=<status>` to the query). Undefined where a wallet could not open it: the profile only
 * allows https callbacks, so a local http build polls instead.
 */
export function appConnectCallbackUrl(pageUrl: string, requestHashHex: string): string | undefined {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const network = url.searchParams.get('network');
  url.search = '';
  url.hash = '';
  if (network) url.searchParams.set('network', network);
  url.searchParams.set(CALLBACK_REQUEST_PARAM, requestHashHex);
  return url.toString();
}
