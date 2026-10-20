// Ported from Yappr's lib/app-connect/session-health.test.ts (one comment key instead of a group key).
import { describe, expect, it } from 'vitest';
import { appConnectStanding, primaryKey, reconcileSessionWithChain } from './health';
import type { AppConnectIdentityKey, AppConnectSession, AppConnectSessionKey } from './protocol';

const DAY = 24 * 60 * 60_000;
const NOW = 1_000 * DAY;
/** A grant of 100 units of 1e9 credits, so shares of it clear the budget floor. */
const UNIT = 1_000_000_000n;
const DISCUSSION = 'discussion';

function commentKey(overrides: Partial<AppConnectSessionKey> = {}): AppConnectSessionKey {
  return {
    keyId: 5,
    bounds: { kind: 'singleContract', contractId: DISCUSSION },
    securityLevel: 2,
    totalBudget: 100n * UNIT,
    remainingBudget: 50n * UNIT,
    expiresAt: NOW + 60 * DAY,
    keyRef: 'key-5',
    ...overrides,
  };
}

function session(authKeys: AppConnectSessionKey[] = [commentKey()]): AppConnectSession {
  return {
    v: 1,
    network: 'testnet',
    identityId: 'alice',
    appId: DISCUSSION,
    groupId: '',
    connectionId: '00'.repeat(16),
    grantedAt: 0,
    authKeys,
    encKeys: [],
  };
}

const standing = (s: AppConnectSession) => appConnectStanding(primaryKey(s, DISCUSSION), NOW);
const health = (s: AppConnectSession) => standing(s).health;

describe('appConnectStanding', () => {
  it('is ok with budget and time to spare', () => {
    expect(standing(session())).toEqual({ health: 'ok', renewSoon: null });
  });

  it('asks to renew soon under 20% of the allowance or 14 days, and says which', () => {
    expect(standing(session([commentKey({ remainingBudget: 19n * UNIT })]))).toEqual({ health: 'renew-soon', renewSoon: 'allowance' });
    expect(health(session([commentKey({ remainingBudget: 20n * UNIT })]))).toBe('ok');
    expect(standing(session([commentKey({ expiresAt: NOW + 13 * DAY })]))).toEqual({ health: 'renew-soon', renewSoon: 'expiry' });
  });

  it('counts an unread grant as unspent, and flags one below the floor', () => {
    expect(health(session([commentKey({ remainingBudget: undefined })]))).toBe('ok');
    expect(health(session([commentKey({ totalBudget: 1000n, remainingBudget: undefined })]))).toBe('renew-soon');
    expect(health(session([commentKey({ remainingBudget: UNIT - 1n })]))).toBe('renew-soon');
  });

  it('requires renewal when spent, expired, disabled or missing', () => {
    expect(health(session([commentKey({ remainingBudget: 0n })]))).toBe('renew-required');
    expect(health(session([commentKey({ expiresAt: NOW + 60_000 })]))).toBe('renew-required');
    expect(health(session([commentKey({ disabled: true })]))).toBe('renew-required');
    expect(health(session([]))).toBe('renew-required');
    // A key bound elsewhere is not the comment key.
    expect(health(session([commentKey({ bounds: { kind: 'singleContract', contractId: 'other' } })]))).toBe('renew-required');
  });
});

describe('reconcileSessionWithChain', () => {
  const chain = (overrides: Partial<AppConnectIdentityKey> = {}): AppConnectIdentityKey[] => [
    {
      id: 5,
      type: 0,
      purpose: 0,
      securityLevel: 2,
      data: new Uint8Array(33),
      bounds: { kind: 'singleContract', contractId: DISCUSSION },
      totalBudget: 100n,
      expiresAt: NOW + 60 * DAY,
      ...overrides,
    },
  ];

  it('applies the chain budget', () => {
    const result = reconcileSessionWithChain(session(), chain(), new Map([[5, 12n]]));
    expect(result).toMatchObject({ revoked: false });
    if (!result.revoked) expect(result.session.authKeys[0].remainingBudget).toBe(12n);
  });

  it('keeps the cached budget when the read gave none', () => {
    const result = reconcileSessionWithChain(session(), chain(), new Map());
    if (!result.revoked) expect(result.session.authKeys[0].remainingBudget).toBe(50n * UNIT);
  });

  it('signs out when the key is disabled, gone, or no longer what the session recorded', () => {
    expect(reconcileSessionWithChain(session(), chain({ disabledAt: 1 }), new Map()).revoked).toBe(true);
    expect(reconcileSessionWithChain(session(), [], new Map()).revoked).toBe(true);
    expect(
      reconcileSessionWithChain(session(), chain({ bounds: { kind: 'singleContract', contractId: 'other' } }), new Map()).revoked,
    ).toBe(true);
    expect(reconcileSessionWithChain(session(), chain({ securityLevel: 1 }), new Map()).revoked).toBe(true);
  });
});
