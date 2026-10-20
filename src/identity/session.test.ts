import * as secp256k1 from '@noble/secp256k1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWalletSessions } from '../appconnect/runtime';
import { WalletSessions } from '../appconnect/sessions';
import { commentGrant, fakePort, memoryBackend } from '../appconnect/testing';
import { hash160 } from '../appconnect/protocol/legacy';
import { CHARTERS_CONTRACT_ID } from '../charters/documents';
import { bytesToHex } from '../model/bytes';
import type { KeyInfo } from './keys';

/**
 * Routing of document writes between the wallet's key, a pasted key, and the
 * typed reasons why neither can sign. The SDK is a fake: identities, keys and
 * the signer are plain objects, and private keys are matched by HASH160.
 */
const DISCUSSION = '2iaUXM8bZb6paYW1mRWCEUMe8EU1tp4Tbg456PXPN3qt';
const ALICE = 'GYtdCkwmxfGQk96rjuMgbdrFG4tzNpV9wnkG3zjRt2m6';
const COMMENT = { contractId: DISCUSSION, documentType: 'comment' };
const CHARTER = { contractId: CHARTERS_CONTRACT_ID, documentType: 'submittedCharter' };

vi.stubEnv('VITE_DISCUSSION_TESTNET_CONTRACT_ID', DISCUSSION);

const walletPrivate = new Uint8Array(32).fill(9);
const walletPub = secp256k1.getPublicKey(walletPrivate, true);
const walletHash = bytesToHex(hash160(walletPub));

interface FakeKey {
  keyId: number;
  purpose: string;
  securityLevel: string;
  keyType: string;
  isReadOnly: boolean;
  disabledAt?: bigint;
  data: string;
  keyTypeNumber: number;
  purposeNumber: number;
  securityLevelNumber: number;
  totalBudget?: bigint;
  expiresAt?: bigint;
  contractBounds?: { toJSON(): unknown };
  getPublicKeyHash(): string;
  free(): void;
}

let chainKeys: FakeKey[] = [];
const signed: number[] = [];

function walletChainKey(overrides: Partial<FakeKey> = {}): FakeKey {
  return {
    keyId: 7,
    purpose: 'AUTHENTICATION',
    securityLevel: 'HIGH',
    keyType: 'ECDSA_SECP256K1',
    isReadOnly: false,
    data: bytesToHex(walletPub),
    keyTypeNumber: 0,
    purposeNumber: 0,
    securityLevelNumber: 2,
    totalBudget: 10_000_000_000n,
    expiresAt: BigInt(Date.now() + 90 * 86_400_000),
    contractBounds: { toJSON: () => ({ $type: 'singleContract', id: DISCUSSION }) },
    getPublicKeyHash: () => walletHash,
    free: () => undefined,
    ...overrides,
  };
}

const fakeHandle = {
  network: 'testnet',
  sdk: {
    identities: {
      fetch: async (id: string) => ({
        id: { toBase58: () => id },
        balance: 5n,
        revision: 1n,
        publicKeys: chainKeys,
        getPublicKeyById: (keyId: number) => chainKeys.find((k) => k.keyId === keyId),
        free: () => undefined,
      }),
      keysRemainingBudgets: async () => new Map(),
    },
    dpns: { usernames: async () => ['alice.dash'] },
  },
  mod: {
    PrivateKey: {
      fromBytes: (bytes: Uint8Array) => {
        const hash = bytesToHex(hash160(secp256k1.getPublicKey(bytes, true)));
        return { getPublicKeyHash: () => hash, free: () => undefined };
      },
      fromWIF: () => ({ getPublicKeyHash: () => 'pasted', free: () => undefined }),
    },
    IdentitySigner: class {
      addKey() {}
      free() {}
    },
  },
};

vi.mock('../sdk/connection', () => ({ loadSdk: async () => fakeHandle }));

const session = await import('./session');
type Handle = Parameters<typeof session.withDocumentSigner>[0];
const handle = fakeHandle as unknown as Handle;

let port: ReturnType<typeof fakePort>;
let ring: WalletSessions;

async function signInWithWalletKey() {
  chainKeys = [walletChainKey()];
  const grant = commentGrant(ALICE, DISCUSSION, { privateKey: walletPrivate, data: walletPub });
  port.keys = [{ ...grant.authKeys[0].key }];
  await session.signInWithWallet('testnet', grant);
}

const pastedKey = (overrides: Partial<KeyInfo> = {}): KeyInfo => ({
  keyId: 1,
  purpose: 'AUTHENTICATION',
  securityLevel: 'HIGH',
  keyType: 'ECDSA_SECP256K1',
  readOnly: false,
  disabled: false,
  dataHex: '02',
  hash160: 'pasted',
  ...overrides,
});

beforeEach(() => {
  port = fakePort();
  ring = new WalletSessions({
    config: { network: 'testnet', appId: DISCUSSION, discussionContractId: DISCUSSION },
    port,
    backend: memoryBackend(),
    timers: false,
  });
  setWalletSessions(ring);
  signed.length = 0;
});

afterEach(async () => {
  await session.signOut();
  setWalletSessions(undefined);
});

describe('resolveSigning', () => {
  const now = Date.now();
  const walletKey = {
    keyId: 7,
    bounds: { kind: 'singleContract' as const, contractId: DISCUSSION },
    securityLevel: 2,
    totalBudget: 10_000_000_000n,
    remainingBudget: 10_000_000_000n,
    expiresAt: now + 86_400_000,
    keyRef: 'key-7',
  };
  const base = { network: 'testnet' as const, identityId: ALICE, names: [], balance: 0n, revision: 0n, keys: [] };
  const viaWallet = { ...base, via: 'wallet' as const };

  it('sends a comment to the wallet key', () => {
    expect(session.resolveSigning(viaWallet, COMMENT, [walletKey], now)).toMatchObject({ kind: 'wallet', key: { keyId: 7 } });
  });

  it('asks for a key for a charter write while signed in with the wallet', () => {
    expect(session.resolveSigning(viaWallet, CHARTER, [walletKey], now)).toEqual({
      kind: 'problem',
      problem: {
        reason: 'needs-key',
        message: "Dash Wallet can't sign moderation-charter documents yet. Add a HIGH authentication key for this step.",
      },
    });
  });

  it('signs a charter write with a key added for the step', () => {
    expect(session.resolveSigning({ ...viaWallet, pastedKey: pastedKey() }, CHARTER, [walletKey], now)).toMatchObject({
      kind: 'pasted',
      key: { keyId: 1 },
    });
  });

  it('asks to renew when the wallet key expired or spent its allowance, unless a pasted key covers it', () => {
    const expired = { ...walletKey, expiresAt: now - 1 };
    const spent = { ...walletKey, remainingBudget: 0n };
    expect(session.resolveSigning(viaWallet, COMMENT, [expired], now)).toMatchObject({ kind: 'problem', problem: { reason: 'renew' } });
    expect(session.resolveSigning(viaWallet, COMMENT, [spent], now)).toMatchObject({ kind: 'problem', problem: { reason: 'renew' } });
    expect(session.resolveSigning({ ...viaWallet, pastedKey: pastedKey() }, COMMENT, [spent], now)).toMatchObject({ kind: 'pasted' });
  });

  it('routes a key sign-in by the key, and refuses one that cannot sign the type', () => {
    const viaKey = { ...base, via: 'key' as const, pastedKey: pastedKey() };
    expect(session.resolveSigning(viaKey, COMMENT, undefined, now)).toMatchObject({ kind: 'pasted' });
    const reasonOnly = pastedKey({ bounds: { kind: 'documentType', contractId: CHARTERS_CONTRACT_ID, documentTypeName: 'reason' } });
    expect(session.resolveSigning({ ...viaKey, pastedKey: reasonOnly }, CHARTER, undefined, now)).toMatchObject({
      kind: 'problem',
      problem: { reason: 'needs-key' },
    });
  });

  it('says to sign in when nobody is', () => {
    expect(session.documentSigningProblem(null, COMMENT)).toEqual({ reason: 'signed-out', message: 'Sign in first.' });
  });
});

describe('withDocumentSigner with a wallet sign-in', () => {
  it('signs a comment with the wallet key and refuses a charter write before anything is built', async () => {
    await signInWithWalletKey();
    const result = await session.withDocumentSigner(handle, COMMENT, async (s) => {
      signed.push(s.identityKey.keyId);
      return { status: 'confirmed' as const, value: 'doc' };
    });
    expect(result).toEqual({ status: 'confirmed', value: 'doc' });
    expect(signed).toEqual([7]);
    await expect(session.withDocumentSigner(handle, CHARTER, async () => 'never')).rejects.toMatchObject({
      name: 'SigningUnavailableError',
      reason: 'needs-key',
    });
  });

  it('signs the user out when the wallet revoked the key', async () => {
    await signInWithWalletKey();
    const signedOut: unknown[] = [];
    // The chain now shows the key disabled.
    chainKeys = [walletChainKey({ disabledAt: 1n })];
    port.keys = [{ ...port.keys[0], disabledAt: 1 }];
    await expect(
      session.withDocumentSigner(handle, COMMENT, async () => {
        signedOut.push('signed');
        return 'never';
      }),
    ).rejects.toMatchObject({ reason: 'signed-out' });
    expect(signedOut).toEqual([]);
    expect(ring.current()).toBeNull();
  });

  it('marks the ring for renewal when Platform says the allowance is spent', async () => {
    await signInWithWalletKey();
    port.budgets = new Map([[7, 0n]]);
    await session.withDocumentSigner(handle, COMMENT, async () => ({
      status: 'refused' as const,
      error: { code: 20015, message: 'spent', detail: 'spent' },
    }));
    expect(ring.getStatus().health).toBe('renew-required');
  });
});
