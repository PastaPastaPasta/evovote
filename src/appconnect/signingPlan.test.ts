// Ported from Yappr's lib/app-connect/signing-plan.test.ts (no groups, tokens or action fees in EvoVote).
import { describe, expect, it } from 'vitest';
import { selectSigningKey, type AppConnectSessionKey } from './protocol';
import { APP_CONNECT_WRITE_COST_ESTIMATE, documentSigningRequest, explainNoCoveringKey, rawSessionKey } from './signingPlan';

const NOW = 1_000_000_000;
const ctx = { now: NOW, groups: [] };

const commentKey = (overrides: Partial<AppConnectSessionKey> = {}): AppConnectSessionKey => ({
  keyId: 5,
  bounds: { kind: 'singleContract', contractId: 'discussion' },
  securityLevel: 2,
  totalBudget: 10_000_000_000n,
  remainingBudget: 5_000_000_000n,
  expiresAt: NOW + 86_400_000,
  keyRef: 'key-5',
  ...overrides,
});

describe('the web signing requests', () => {
  it('route a comment to the comment key, and nothing else', () => {
    expect(selectSigningKey([commentKey()], documentSigningRequest('discussion', 'comment'), ctx)).toMatchObject({
      ok: true,
      key: { keyId: 5 },
    });
    expect(selectSigningKey([commentKey()], documentSigningRequest('charters', 'submittedCharter'), ctx)).toMatchObject({ ok: false });
  });
});

describe('the write cost estimate', () => {
  it('passes over a key with less allowance left than one write, and asks to renew', () => {
    const nearlySpent = commentKey({ remainingBudget: APP_CONNECT_WRITE_COST_ESTIMATE - 1n });
    expect(selectSigningKey([nearlySpent], documentSigningRequest('discussion', 'comment'), ctx)).toMatchObject({ ok: false });
    expect(explainNoCoveringKey([nearlySpent], documentSigningRequest('discussion', 'comment'), ctx)).toBe('renew');
    expect(
      selectSigningKey([commentKey({ remainingBudget: APP_CONNECT_WRITE_COST_ESTIMATE })], documentSigningRequest('discussion', 'comment'), ctx),
    ).toMatchObject({ ok: true });
  });
});

describe('explainNoCoveringKey', () => {
  it('asks to renew when a covering key is spent or expired', () => {
    expect(explainNoCoveringKey([commentKey({ remainingBudget: 0n })], documentSigningRequest('discussion', 'comment'), ctx)).toBe('renew');
    expect(explainNoCoveringKey([commentKey({ expiresAt: NOW })], documentSigningRequest('discussion', 'comment'), ctx)).toBe('renew');
  });

  it('says the wallet cannot when nothing covers the write, or the covering key was revoked', () => {
    expect(explainNoCoveringKey([commentKey()], documentSigningRequest('charters', 'reason'), ctx)).toBe('wallet');
    expect(explainNoCoveringKey([commentKey({ disabled: true })], documentSigningRequest('discussion', 'comment'), ctx)).toBe('wallet');
  });
});

describe('rawSessionKey', () => {
  const base = { id: 3, type: 0, purpose: 0, securityLevel: 2, data: new Uint8Array(33) };

  it('skips the selector for an unbound key without limits', () => {
    expect(rawSessionKey(base, undefined)).toBeNull();
  });

  it('makes a bound or limited pasted key a one-key ring', () => {
    expect(rawSessionKey({ ...base, bounds: { kind: 'singleContract', contractId: 'discussion' } }, undefined)).toMatchObject({
      keyId: 3,
      bounds: { kind: 'singleContract', contractId: 'discussion' },
      keyRef: 'raw',
    });
    expect(rawSessionKey({ ...base, totalBudget: 9n }, 4n)).toMatchObject({ totalBudget: 9n, remainingBudget: 4n });
  });
});
