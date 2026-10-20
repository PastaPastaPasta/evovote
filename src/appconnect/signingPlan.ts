import {
  KeySecurityLevel,
  selectSigningKey,
  type AppConnectIdentityKey,
  type AppConnectSessionKey,
  type SelectSigningKeyContext,
  type SigningRequest,
} from './protocol';

/**
 * Pure helpers around the core `selectSigningKey` (from Yappr's
 * lib/app-connect/signing-plan.ts). Every document type EvoVote writes keeps
 * a `signatureSecurityLevelRequirement` of HIGH.
 */

/**
 * What one write is assumed to cost when choosing a budgeted key: 2e8
 * credits, well above a comment. A key with less left is passed over, so the
 * write goes to renewal instead of being broadcast and refused. Platform
 * charges the real cost; this only guards the choice.
 */
export const APP_CONNECT_WRITE_COST_ESTIMATE = 200_000_000n;

export function documentSigningRequest(contractId: string, documentType: string): SigningRequest {
  return {
    transition: 'batch',
    members: [{ contractId, documentType, securityLevel: KeySecurityLevel.HIGH, estimatedCost: APP_CONNECT_WRITE_COST_ESTIMATE }],
  };
}

/**
 * Why no key could sign: `renew` when a key would cover the write but is
 * expired or out of allowance (a new grant fixes it), `wallet` when nothing
 * in the ring covers it at all.
 */
export function explainNoCoveringKey(
  keys: AppConnectSessionKey[],
  request: SigningRequest,
  ctx: SelectSigningKeyContext,
): 'renew' | 'wallet' {
  const unlimited = keys
    .filter((key) => !key.disabled)
    .map((key) => ({ ...key, expiresAt: undefined, totalBudget: undefined, remainingBudget: undefined }));
  const relaxed = selectSigningKey(unlimited, request, ctx);
  return relaxed.ok || relaxed.reason === 'needs-split' ? 'renew' : 'wallet';
}

/**
 * A pasted key as a one-key ring: the key with the bounds and limits it has
 * on chain. Null when the key needs no selector check (unbound and without
 * limits).
 */
export function rawSessionKey(key: AppConnectIdentityKey, remainingBudget: bigint | undefined): AppConnectSessionKey | null {
  if (!key.bounds && key.totalBudget === undefined && key.expiresAt === undefined) return null;
  return {
    keyId: key.id,
    bounds: key.bounds,
    securityLevel: key.securityLevel,
    totalBudget: key.totalBudget,
    remainingBudget,
    expiresAt: key.expiresAt,
    keyRef: 'raw',
  };
}
