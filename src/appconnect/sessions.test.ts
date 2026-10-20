import { describe, expect, it, vi } from 'vitest';
import { WalletSessions } from './sessions';
import { commentGrant, fakePort, memoryBackend } from './testing';

const DISCUSSION = 'discussion-contract';
const ALICE = 'alice';
const config = { network: 'testnet' as const, appId: DISCUSSION, discussionContractId: DISCUSSION };

function ring(backend = memoryBackend(), port = fakePort()) {
  return { sessions: new WalletSessions({ config, port, backend, timers: false }), backend, port };
}

function chainKeyFor(grant: ReturnType<typeof commentGrant>) {
  return { ...grant.authKeys[0].key };
}

describe('WalletSessions', () => {
  it('adopts a grant, wipes its private keys, and keeps them wrapped for the next page load', async () => {
    const { sessions, backend, port } = ring();
    const grant = commentGrant(ALICE, DISCUSSION);
    port.keys = [chainKeyFor(grant)];
    const session = await sessions.adopt(grant);
    expect(grant.authKeys[0].privateKey.every((b) => b === 0)).toBe(true);
    expect(sessions.current(ALICE)).toBe(session);
    expect(sessions.getStatus()).toMatchObject({ identityId: ALICE, health: 'ok' });
    expect((await sessions.privateKey(session, session.authKeys[0].keyRef))?.every((b) => b === 9)).toBe(true);

    // A reload: a new manager over the same storage restores without asking the wallet.
    const reloaded = new WalletSessions({ config, port, backend, timers: false });
    const restored = await reloaded.restore();
    expect(restored?.identityId).toBe(ALICE);
    expect(restored?.authKeys[0]).toMatchObject({ keyId: 7, bounds: { kind: 'singleContract', contractId: DISCUSSION } });
  });

  it('drops a stored ring made for another app id', async () => {
    const { sessions, backend } = ring();
    await sessions.adopt(commentGrant(ALICE, DISCUSSION));
    const other = new WalletSessions({ config: { ...config, appId: 'another-app' }, port: fakePort(), backend, timers: false });
    expect(await other.restore()).toBeNull();
    expect(await sessions.keyStore().load('testnet')).toBeNull();
  });

  it('signs out by forgetting the ring but keeping the connection id', async () => {
    const { sessions } = ring();
    const connectionId = await sessions.connectionId();
    await sessions.adopt(commentGrant(ALICE, DISCUSSION));
    await sessions.logout(ALICE);
    expect(sessions.current()).toBeNull();
    expect(await sessions.keyStore().load('testnet')).toBeNull();
    expect(await sessions.connectionId()).toBe(connectionId);
  });

  it('signs out when the wallet revoked the key, and says so', async () => {
    const { sessions, port } = ring();
    const grant = commentGrant(ALICE, DISCUSSION);
    port.keys = [chainKeyFor(grant)];
    await sessions.adopt(grant);
    const signedOut = vi.fn();
    sessions.onSignedOut(signedOut);
    port.keys = [{ ...port.keys[0], disabledAt: 1 }];
    await sessions.refresh();
    expect(sessions.current()).toBeNull();
    expect(sessions.getStatus().signedOutByWallet).toBe(true);
    expect(signedOut).toHaveBeenCalledWith(ALICE);
    expect(await sessions.keyStore().load('testnet')).toBeNull();
  });

  it('switches to a newer grant another tab stored instead of signing out', async () => {
    const backend = memoryBackend();
    const port = fakePort();
    const tabA = new WalletSessions({ config, port, backend, timers: false });
    const tabB = new WalletSessions({ config, port, backend, timers: false });
    const old = commentGrant(ALICE, DISCUSSION, { keyId: 7 });
    port.keys = [chainKeyFor(old)];
    await tabA.adopt(old);
    // Tab B signs in again: the wallet disables key 7 and adds key 8.
    const renewed = commentGrant(ALICE, DISCUSSION, { keyId: 8 });
    await tabB.adopt(renewed);
    port.keys = [{ ...port.keys[0], disabledAt: 1 }, chainKeyFor(commentGrant(ALICE, DISCUSSION, { keyId: 8 }))];
    await tabA.refresh();
    expect(tabA.current(ALICE)?.authKeys[0].keyId).toBe(8);
    expect(tabA.getStatus().signedOutByWallet).toBe(false);
  });

  it('applies the chain budget on refresh', async () => {
    const { sessions, port } = ring();
    const grant = commentGrant(ALICE, DISCUSSION);
    port.keys = [chainKeyFor(grant)];
    await sessions.adopt(grant);
    port.budgets = new Map([[7, 1_000_000n]]);
    await sessions.refresh();
    expect(sessions.current()?.authKeys[0].remainingBudget).toBe(1_000_000n);
    expect(sessions.getStatus().health).toBe('renew-soon');
  });

  it('asks to renew on a spent allowance, and signs out on a disabled key', async () => {
    const { sessions, port } = ring();
    const grant = commentGrant(ALICE, DISCUSSION);
    port.keys = [chainKeyFor(grant)];
    await sessions.adopt(grant);
    expect(await sessions.handleWriteFailure(ALICE, 20015)).toBe('allowance-spent');
    expect(sessions.getStatus().renewRequired).toBe('allowance-spent');
    expect(await sessions.handleWriteFailure(ALICE, 40100)).toBeNull();
    port.keys = [{ ...port.keys[0], disabledAt: 1 }];
    expect(await sessions.handleWriteFailure(ALICE, 40208)).toBe('key-disabled');
    expect(sessions.current()).toBeNull();
  });

  it('lets a sign-out overtake an adoption still storing its keys', async () => {
    const { sessions } = ring();
    const adopting = sessions.adopt(commentGrant(ALICE, DISCUSSION));
    await sessions.logout(ALICE);
    await expect(adopting).rejects.toThrow(/Signed out/);
    expect(sessions.current()).toBeNull();
    expect(await sessions.keyStore().load('testnet')).toBeNull();
  });
});
