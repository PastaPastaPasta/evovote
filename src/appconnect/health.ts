import {
  APP_CONNECT_RENEW_BUDGET_FLOOR,
  APP_CONNECT_RENEW_BUDGET_SHARE,
  APP_CONNECT_RENEW_WITHIN_MS,
} from './config';
import {
  APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS,
  boundsEqual,
  type AppConnectIdentityKey,
  type AppConnectSession,
  type AppConnectSessionKey,
} from './protocol';

/**
 * (From Yappr's lib/app-connect/session-health.ts, with the group key
 * replaced by EvoVote's one comment key.)
 *
 * `ok`: nothing to say. `renew-soon`: under 20% of the allowance, under the
 * floor, or under 14 days left. `renew-required`: comments stop until the
 * user signs in with the wallet again; reads continue.
 */
export type AppConnectHealth = 'ok' | 'renew-soon' | 'renew-required';

/** What `renew-soon` is about: the allowance running low, or the time left. */
export type RenewSoonReason = 'allowance' | 'expiry';

/** The primary key: the one bound to the discussion contract (binding 0 of EvoVote's request). */
export function primaryKey(session: AppConnectSession, discussionContractId: string): AppConnectSessionKey | undefined {
  return session.authKeys.find(
    (key) => key.bounds?.kind === 'singleContract' && key.bounds.contractId === discussionContractId,
  );
}

/** The session's health and, when it is `renew-soon`, why. */
export function appConnectStanding(
  key: AppConnectSessionKey | undefined,
  now: number,
): { health: AppConnectHealth; renewSoon: RenewSoonReason | null } {
  if (!key || key.disabled) return { health: 'renew-required', renewSoon: null };
  if (key.expiresAt !== undefined && key.expiresAt - now <= APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS) {
    return { health: 'renew-required', renewSoon: null };
  }
  if (key.totalBudget !== undefined) {
    // Until the first read a grant is as the wallet gave it: all of its budget left.
    const remaining = key.remainingBudget ?? key.totalBudget;
    if (remaining <= 0n) return { health: 'renew-required', renewSoon: null };
    // remaining / total < share, in integers.
    const lowShare = remaining * 100n < key.totalBudget * BigInt(Math.round(APP_CONNECT_RENEW_BUDGET_SHARE * 100));
    if (lowShare || remaining < APP_CONNECT_RENEW_BUDGET_FLOOR) return { health: 'renew-soon', renewSoon: 'allowance' };
  }
  if (key.expiresAt !== undefined && key.expiresAt - now <= APP_CONNECT_RENEW_WITHIN_MS) {
    return { health: 'renew-soon', renewSoon: 'expiry' };
  }
  return { health: 'ok', renewSoon: null };
}

/**
 * Compares the session with the identity's keys on chain. `revoked` when any
 * session key is gone, disabled, or no longer the key the session recorded
 * (the wallet revoked or superseded this browser's grant): the session must
 * be wiped. Otherwise the session with every key's chain state applied.
 */
export function reconcileSessionWithChain(
  session: AppConnectSession,
  chainKeys: readonly AppConnectIdentityKey[],
  budgets: ReadonlyMap<number, bigint | undefined>,
): { revoked: true } | { revoked: false; session: AppConnectSession } {
  const byId = new Map(chainKeys.map((key) => [key.id, key]));
  const live = (keyId: number) => {
    const key = byId.get(keyId);
    return key && key.disabledAt === undefined ? key : undefined;
  };
  if (session.authKeys.some((key) => !live(key.keyId)) || session.encKeys.some((key) => !live(key.keyId))) {
    return { revoked: true };
  }
  for (const key of session.authKeys) {
    const chain = byId.get(key.keyId) as AppConnectIdentityKey;
    const sameBounds = chain.bounds && key.bounds ? boundsEqual(chain.bounds, key.bounds) : chain.bounds === key.bounds;
    if (!sameBounds || chain.securityLevel !== key.securityLevel) return { revoked: true };
  }
  return {
    revoked: false,
    session: {
      ...session,
      authKeys: session.authKeys.map((key) => {
        const chain = byId.get(key.keyId) as AppConnectIdentityKey;
        return {
          ...key,
          totalBudget: chain.totalBudget,
          expiresAt: chain.expiresAt,
          remainingBudget: chain.totalBudget === undefined ? undefined : (budgets.get(key.keyId) ?? key.remainingBudget),
        };
      }),
    },
  };
}
