import * as mod from '@dashevo/evo-sdk';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHARTERS_CONTRACT_ID } from '../charters/documents';
import { bytesToHex, hexToBytes } from '../model/bytes';
import type { SdkHandle } from '../sdk/connection';
import { dip13Wallet, type Dip13Key, type Dip13Wallet } from './dip13';
import type { KeyInfo } from './keys';
import {
  findPhraseKey,
  INVALID_PHRASE,
  keyFromPhrase,
  looksLikeRecoveryPhrase,
  MAX_IDENTITY_INDEXES,
  NOT_A_PHRASE,
  phraseCandidates,
  recoveryPhraseWarning,
} from './phraseKeys';

/** BIP-39's public all-zero-entropy test phrase (never a real wallet's); its keys are pinned in dip13.test.ts. */
const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** testnet m/9'/1'/5'/0'/0'/identity'/key' public keys of TEST_PHRASE. */
const PUB = {
  i0k0: '03a00f4853081aeb8c9debe37267303fa133bd7f6678bfb3299dfa001bfd0341db',
  i0k1: '03280859fd14d1b8a7a75d918dd0a1bf922be5af7eff9aafa26f446ea5f16da616',
  i0k2: '02cb109b54e542efbb86f3e5ba1d6a2da97d02cc4de0c706c23ab8ddb53ff7fe3e',
  i1k0: '0312aa9ac813f9751da6747c4ac7798a9c5f778545788204785eafbfe287544144',
  i1k1: '03a8150f657be60fe91fec7aefe69d655247417e9e7ab408d209261b57f798ce84',
};
const ME = 'GYtdCkwmxfGQk96rjuMgbdrFG4tzNpV9wnkG3zjRt2m6';
const SOMEONE_ELSE = '9idHpqmf8i9U6tfWiWMQCVF39vshNgYisT7DL6yK2pCF';
const OTHER_PUB = '02' + '11'.repeat(32);

const h160 = (pubHex: string) => bytesToHex(ripemd160(sha256(hexToBytes(pubHex))));

function key(keyId: number, securityLevel: string, pubHex: string, overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {
    keyId,
    purpose: 'AUTHENTICATION',
    securityLevel,
    keyType: 'ECDSA_SECP256K1',
    readOnly: false,
    disabled: false,
    dataHex: pubHex,
    hash160: h160(pubHex),
    ...overrides,
  };
}

/** Records every key a wallet derives, to check all but the returned one are zeroed. */
function recording(wallet: Dip13Wallet): Dip13Wallet & { derived: Dip13Key[] } {
  const derived: Dip13Key[] = [];
  return {
    derived,
    derive(path) {
      const k = wallet.derive(path);
      derived.push(k);
      return k;
    },
  };
}

/** A master-key lookup answering from `owners` (HASH160 hex -> identity id), counting calls. */
function lookup(owners: Record<string, string> = {}, fallback?: string) {
  const calls: string[] = [];
  const fn = async (hash: string) => {
    calls.push(hash);
    return owners[hash] ?? fallback;
  };
  return Object.assign(fn, { calls });
}

let wallet: Dip13Wallet;
beforeAll(async () => {
  await mod.ensureInitialized();
  wallet = dip13Wallet(mod.WasmSdk, TEST_PHRASE, 'testnet');
});

const find = (keys: KeyInfo[], want: 'document-signing' | 'master', identityByMasterHash = lookup(), w = wallet) =>
  findPhraseKey({ wallet: w, network: 'testnet', identityId: ME, who: 'alice.dash', keys, want, identityByMasterHash });

describe('phraseCandidates (key level)', () => {
  it('takes enabled, unbound HIGH keys before CRITICAL ones, never MASTER, MEDIUM, bound or disabled keys', () => {
    const keys = [
      key(0, 'MASTER', PUB.i0k0),
      key(1, 'CRITICAL', PUB.i0k1),
      key(2, 'HIGH', PUB.i0k2),
      key(3, 'MEDIUM', OTHER_PUB),
      key(4, 'HIGH', OTHER_PUB, { bounds: { kind: 'singleContract', contractId: CHARTERS_CONTRACT_ID } }),
      key(5, 'HIGH', OTHER_PUB, { disabled: true }),
      key(6, 'HIGH', OTHER_PUB, { purpose: 'ENCRYPTION' }),
      key(7, 'HIGH', OTHER_PUB, { keyType: 'BLS12_381' }),
    ];
    expect(phraseCandidates(keys, 'document-signing').map((k) => k.keyId)).toEqual([2, 1]);
    expect(phraseCandidates(keys, 'master').map((k) => k.keyId)).toEqual([0]);
    expect(phraseCandidates([key(0, 'MASTER', PUB.i0k0, { disabled: true })], 'master')).toEqual([]);
  });
});

describe('findPhraseKey', () => {
  it("picks the identity's HIGH key over its CRITICAL one, without asking the network", async () => {
    const ask = lookup();
    const w = recording(wallet);
    const found = await find([key(0, 'MASTER', PUB.i0k0), key(1, 'CRITICAL', PUB.i0k1), key(2, 'HIGH', PUB.i0k2)], 'document-signing', ask, w);
    expect(found).toMatchObject({ ok: true, key: { keyId: 2, securityLevel: 'HIGH' } });
    expect(ask.calls).toEqual([]);
    // The private key handed back is the one for the key's public point; nothing else was derived.
    expect(w.derived).toHaveLength(1);
    expect(found.ok && bytesToHex(found.privateKey)).not.toBe('00'.repeat(32));
  });

  it('falls back to a CRITICAL key when the phrase holds no HIGH one', async () => {
    const found = await find([key(1, 'CRITICAL', PUB.i0k1), key(2, 'HIGH', OTHER_PUB)], 'document-signing', lookup({ [h160(PUB.i0k0)]: ME }));
    expect(found).toMatchObject({ ok: true, key: { keyId: 1, securityLevel: 'CRITICAL' } });
  });

  it('derives the MASTER key for a charter-key update', async () => {
    const found = await find([key(0, 'MASTER', PUB.i0k0), key(2, 'HIGH', PUB.i0k2)], 'master');
    expect(found).toMatchObject({ ok: true, key: { keyId: 0, securityLevel: 'MASTER' } });
  });

  it("walks identity indexes past another identity of the phrase, zeroing every key it doesn't return", async () => {
    // This identity is the phrase's second (index 1); index 0 is someone else's.
    const ask = lookup({ [h160(PUB.i0k0)]: SOMEONE_ELSE });
    const w = recording(wallet);
    const found = await find([key(0, 'MASTER', PUB.i1k0), key(1, 'HIGH', PUB.i1k1)], 'document-signing', ask, w);
    expect(found).toMatchObject({ ok: true, key: { keyId: 1 } });
    expect(ask.calls).toEqual([h160(PUB.i0k0)]);
    const zero = '00'.repeat(32);
    const returned = found.ok ? found.privateKey : undefined;
    for (const k of w.derived) {
      if (k.privateKey !== returned) expect(bytesToHex(k.privateKey)).toBe(zero);
    }
  });

  it('refuses a phrase that belongs to a different identity', async () => {
    const found = await find([key(2, 'HIGH', OTHER_PUB)], 'document-signing', lookup({ [h160(PUB.i0k0)]: SOMEONE_ELSE }));
    expect(found.ok).toBe(false);
    expect(!found.ok && found.error).toMatch(/belongs to a different identity, not alice\.dash/);
  });

  it("says when the phrase is this identity's but holds none of the wanted keys", async () => {
    const found = await find([key(2, 'HIGH', OTHER_PUB)], 'document-signing', lookup({ [h160(PUB.i0k0)]: ME }));
    expect(!found.ok && found.error).toMatch(/doesn't hold a HIGH or CRITICAL key of alice\.dash/);
    const master = await find([key(0, 'MASTER', OTHER_PUB)], 'master', lookup({ [h160(PUB.i0k0)]: ME }));
    expect(!master.ok && master.error).toMatch(/doesn't hold alice\.dash's master key/);
  });

  it('stops after the gap limit when the phrase has no identity at all', async () => {
    const ask = lookup();
    const found = await find([key(2, 'HIGH', OTHER_PUB)], 'document-signing', ask);
    expect(!found.ok && found.error).toMatch(/No identity on testnet was created from this recovery phrase/);
    expect(ask.calls).toHaveLength(5);
  });

  it('scans a bounded number of identity indexes even when every one is used', async () => {
    const ask = lookup({}, SOMEONE_ELSE);
    const found = await find([key(2, 'HIGH', OTHER_PUB)], 'document-signing', ask);
    expect(found.ok).toBe(false);
    expect(ask.calls).toHaveLength(MAX_IDENTITY_INDEXES);
  });

  it('refuses at once when the identity has no key a phrase could unlock', async () => {
    const ask = lookup();
    const found = await find([key(4, 'HIGH', PUB.i0k2, { bounds: { kind: 'singleContract', contractId: CHARTERS_CONTRACT_ID } })], 'document-signing', ask);
    expect(!found.ok && found.error).toMatch(/no HIGH or CRITICAL authentication key a recovery phrase can unlock/);
    expect(ask.calls).toEqual([]);
  });

  it('lets a failed lookup throw instead of reading it as "not this phrase"', async () => {
    const failing = async () => {
      throw new Error('DAPI timeout');
    };
    await expect(
      findPhraseKey({ wallet, network: 'testnet', identityId: ME, who: 'alice.dash', keys: [key(2, 'HIGH', OTHER_PUB)], want: 'document-signing', identityByMasterHash: failing }),
    ).rejects.toThrow('DAPI timeout');
  });
});

describe('keyFromPhrase', () => {
  /** A handle with the real wasm module and a fake identity read. */
  function fakeHandle(pubs: Array<[number, string, string]>, owners: Record<string, string> = {}): SdkHandle {
    const publicKeys = pubs.map(([keyId, securityLevel, data]) => ({
      keyId,
      purpose: 'AUTHENTICATION',
      securityLevel,
      keyType: 'ECDSA_SECP256K1',
      isReadOnly: false,
      data,
      getPublicKeyHash: () => h160(data),
      free: () => undefined,
    }));
    return {
      network: 'testnet',
      mod,
      sdk: {
        identities: {
          fetch: async () => ({ publicKeys, free: () => undefined }),
          byPublicKeyHash: async (hash: string) => (owners[hash] ? { id: { toBase58: () => owners[hash] }, free: () => undefined } : undefined),
        },
      },
    } as unknown as SdkHandle;
  }

  it("hands back the matching key's WIF, which loads as that key", async () => {
    const handle = fakeHandle([[0, 'MASTER', PUB.i0k0], [1, 'CRITICAL', PUB.i0k1], [2, 'HIGH', PUB.i0k2]]);
    const found = await keyFromPhrase(handle, { identityId: ME, phrase: TEST_PHRASE, want: 'document-signing' });
    expect(found).toMatchObject({ ok: true, key: { keyId: 2 } });
    if (!found.ok) return;
    const loaded = mod.PrivateKey.fromWIF(found.wif);
    expect(loaded.getPublicKeyHash().toLowerCase()).toBe(h160(PUB.i0k2));
    loaded.free();
    const master = await keyFromPhrase(handle, { identityId: ME, phrase: TEST_PHRASE, want: 'master' });
    expect(master).toMatchObject({ ok: true, key: { keyId: 0 } });
  });

  it('refuses a phrase of another identity on chain', async () => {
    const handle = fakeHandle([[2, 'HIGH', OTHER_PUB]], { [h160(PUB.i0k0)]: SOMEONE_ELSE });
    const found = await keyFromPhrase(handle, { identityId: ME, who: 'alice.dash', phrase: TEST_PHRASE, want: 'document-signing' });
    expect(!found.ok && found.error).toMatch(/different identity, not alice\.dash/);
  });

  it('refuses a mistyped phrase and anything too short to be one', async () => {
    const handle = fakeHandle([[2, 'HIGH', PUB.i0k2]]);
    const broken = TEST_PHRASE.replace(/about$/, 'abandon');
    expect(await keyFromPhrase(handle, { identityId: ME, phrase: broken, want: 'document-signing' })).toEqual({ ok: false, error: INVALID_PHRASE });
    expect(await keyFromPhrase(handle, { identityId: ME, phrase: 'abandon about', want: 'document-signing' })).toEqual({ ok: false, error: NOT_A_PHRASE });
  });
});

describe('phrase wording', () => {
  it('reads 12 or more words as a phrase', () => {
    expect(looksLikeRecoveryPhrase(TEST_PHRASE)).toBe(true);
    expect(looksLikeRecoveryPhrase('abandon abandon abandon abandon abandon about')).toBe(false);
  });

  it('warns plainly, naming testnet only on testnet', () => {
    expect(recoveryPhraseWarning('testnet')).toBe(
      'Your recovery phrase controls your whole wallet. Only enter it on testnet sites you trust.',
    );
    expect(recoveryPhraseWarning('mainnet')).not.toContain('testnet');
  });
});
