/**
 * The write paths, built and signed with real wasm objects and throwaway
 * keys, against a mocked SDK: nothing here touches the network, and nothing
 * is broadcast.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as mod from '@dashevo/evo-sdk';
import type { SdkHandle } from '../sdk/connection';
import type { DocumentSigner } from '../identity/session';
import { isBoundKey, keyInfoFrom } from '../identity/keys';
import { addBoundKey, boundKeyInCreation, generateKey, importPrivateKeyFor } from '../identity/update';
import { REFUSALS } from '../voting/refusals';
import { CHARTER_DECRYPTION, encryptedSize, JOIN_ENCRYPTION } from './boundKeys';
import { CHARTERS_CONTRACT_ID } from './documents';
import {
  applyForSeat,
  buildApplication,
  documentSummary,
  fileReason,
  MODERATION_CONTEST_FUND,
  newCharterDocument,
  submittedCharterProperties,
} from './writes';
import { base58Encode } from '../model/bytes';
import { dashText } from '../model/credits';

const TARGET = 'BGxVk266LDvQGTCFaDGXwpHHkU5MQYDTYNttxgiuAwDP';
const id32 = (n: number) => base58Encode(new Uint8Array(32).fill(n));

beforeAll(async () => {
  await mod.ensureInitialized();
});

/** A throwaway identity: a MASTER key and a HIGH authentication key, freshly generated. */
function throwawayIdentity() {
  const master = generateKey(mod, 'testnet');
  const auth = generateKey(mod, 'testnet');
  const identityId = base58Encode(crypto.getRandomValues(new Uint8Array(32)));
  const publicKey = (keyId: number, securityLevel: 'master' | 'high', pubHex: string) =>
    new mod.IdentityPublicKey({
      keyId,
      purpose: 'authentication',
      securityLevel,
      keyType: 'ecdsa_secp256k1',
      isReadOnly: false,
      data: Uint8Array.from(pubHex.match(/../g)!.map((h) => parseInt(h, 16))),
    });
  const build = (extra: InstanceType<typeof mod.IdentityPublicKey>[] = []) => {
    const identity = new mod.Identity(identityId);
    identity.addPublicKey(publicKey(0, 'master', master.publicKeyHex));
    identity.addPublicKey(publicKey(1, 'high', auth.publicKeyHex));
    for (const k of extra) identity.addPublicKey(k);
    identity.balance = 100_000_000_000n;
    return identity;
  };
  return { identityId, master, auth, build, authKey: () => publicKey(1, 'high', auth.publicKeyHex) };
}

const handleWith = (sdk: unknown): SdkHandle => ({ sdk: sdk as SdkHandle['sdk'], mod, network: 'testnet' });

describe('charter documents (built offline)', () => {
  it('should build a submittedCharter whose identifiers stay bytes', () => {
    const doc = newCharterDocument(
      mod,
      'submittedCharter',
      id32(9),
      submittedCharterProperties(TARGET, {
        description: '  We moderate spam.  ',
        reasonIds: [id32(1), id32(2)],
        moderatorsShare: 60,
        rewardSplit: { leader: 40, equal: 30, actions: 30 },
      }),
    );
    try {
      expect(doc.documentTypeName).toBe('submittedCharter');
      expect(doc.ownerId.toBase58()).toBe(id32(9));
      expect(doc.dataContractId.toBase58()).toBe(CHARTERS_CONTRACT_ID);
      expect(doc.entropy).toHaveLength(32);
      expect(doc.properties.targetContractId).toBeInstanceOf(Uint8Array);
      // Integers come back from the wasm document as bigints.
      expect(documentSummary(doc)).toEqual({
        targetContractId: TARGET,
        description: 'We moderate spam.',
        reasons: [id32(1), id32(2)],
        moderatorsShare: 60n,
        rewardSplit: { leader: 40n, equal: 30n, actions: 30n },
      });
    } finally {
      doc.free();
    }
  });

  it('should leave moderatorsShare out when none is chosen (the chain reads absent as 100)', () => {
    const props = submittedCharterProperties(TARGET, {
      description: 'x',
      reasonIds: [],
      rewardSplit: { leader: 100, equal: 0, actions: 0 },
    });
    expect('moderatorsShare' in props).toBe(false);
    expect(props.reasons).toEqual([]);
  });

  it('should build the application exactly as the confirm step shows it', () => {
    const doc = buildApplication(mod, {
      targetContractId: TARGET,
      leaderId: id32(9),
      submittedCharterId: id32(5),
      members: [id32(6), id32(7)],
    });
    try {
      expect(doc.documentTypeName).toBe('electedCharter');
      expect(documentSummary(doc)).toEqual({
        targetContractId: TARGET,
        submittedCharterId: id32(5),
        members: [id32(6), id32(7)],
      });
    } finally {
      doc.free();
    }
  });

  it('should sign a create batch for a built document with a throwaway key', () => {
    const { auth, authKey } = throwawayIdentity();
    const ownerId = id32(9);
    const doc = newCharterDocument(mod, 'reason', ownerId, { code: 'SPM', label: 'Spam' });
    const transition = new mod.DocumentCreateTransition({ document: doc, identityContractNonce: 1n });
    const batch = mod.BatchTransition.fromBatchedTransitions(
      [new mod.BatchedTransition(transition.toDocumentTransition())],
      ownerId,
      0,
    );
    const st = batch.toStateTransition();
    const privateKey = mod.PrivateKey.fromHex(auth.privateKeyHex, 'testnet');
    const identityKey = authKey();
    try {
      st.sign(privateKey, identityKey);
      expect(st.toBytes().length).toBeGreaterThan(100);
      expect(transition.base.id.toBase58()).not.toBe(base58Encode(new Uint8Array(32)));
    } finally {
      [st, batch, transition, doc, privateKey, identityKey].forEach((o) => o.free());
    }
  });
});

describe('bound keys', () => {
  it('should generate keys for the selected network', () => {
    const testnet = generateKey(mod, 'testnet');
    const mainnet = generateKey(mod, 'mainnet');
    expect(testnet.wif).toMatch(/^c/);
    expect(mainnet.wif).toMatch(/^X/);
    expect(testnet.publicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(testnet.hash160).toMatch(/^[0-9a-f]{40}$/);
    expect(testnet.privateKeyHex).not.toBe(mainnet.privateKeyHex);
  });

  it('should register a MEDIUM secp256k1 key bound to one charters document type', () => {
    const key = generateKey(mod, 'testnet');
    const inCreation = boundKeyInCreation(mod, CHARTER_DECRYPTION, 7, key.publicKeyHex);
    const asKey = inCreation.toIdentityPublicKey();
    try {
      const info = keyInfoFrom(asKey);
      expect(info).toMatchObject({
        keyId: 7,
        purpose: 'DECRYPTION',
        securityLevel: 'MEDIUM',
        keyType: 'ECDSA_SECP256K1',
        bounds: { contractId: CHARTERS_CONTRACT_ID, documentTypeName: 'submittedCharter' },
        dataHex: key.publicKeyHex,
        hash160: key.hash160,
      });
      expect(isBoundKey(info, 'DECRYPTION', CHARTERS_CONTRACT_ID, 'submittedCharter')).toBe(true);
    } finally {
      inCreation.free();
      asKey.free();
    }
  });

  it('should accept only the private half of the on-chain key, on this network', () => {
    const key = generateKey(mod, 'testnet');
    const inCreation = boundKeyInCreation(mod, JOIN_ENCRYPTION, 3, key.publicKeyHex);
    const onChain = keyInfoFrom(inCreation.toIdentityPublicKey());
    inCreation.free();
    expect(importPrivateKeyFor(mod, 'testnet', key.wif, onChain)).toMatchObject({ ok: true, key: { privateKeyHex: key.privateKeyHex } });
    expect(importPrivateKeyFor(mod, 'testnet', generateKey(mod, 'testnet').wif, onChain)).toMatchObject({ ok: false });
    expect(importPrivateKeyFor(mod, 'testnet', generateKey(mod, 'mainnet').wif, onChain)).toEqual({
      ok: false,
      error: 'This is a mainnet key, but you are on testnet.',
    });
  });

  it('should add the key with the master key and confirm it by reading the identity back', async () => {
    const who = throwawayIdentity();
    const newKey = generateKey(mod, 'testnet');
    let registered: InstanceType<typeof mod.IdentityPublicKey> | undefined;
    const update = vi.fn(async (opts: { addPublicKeys: InstanceType<typeof mod.IdentityPublicKeyInCreation>[] }) => {
      expect(opts.addPublicKeys).toHaveLength(1);
      registered = opts.addPublicKeys[0].toIdentityPublicKey();
    });
    const sdk = {
      identities: {
        fetch: vi.fn(async () => who.build(registered ? [registered] : [])),
        update,
      },
    };
    const outcome = await addBoundKey(handleWith(sdk), {
      identityId: who.identityId,
      masterWif: who.master.wif,
      spec: CHARTER_DECRYPTION,
      newKey,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      status: 'confirmed',
      value: { keyId: 2, purpose: 'DECRYPTION', dataHex: newKey.publicKeyHex },
    });
  });

  it('should refuse a key that is not the identity\'s master key before signing anything', async () => {
    const who = throwawayIdentity();
    const update = vi.fn();
    const sdk = { identities: { fetch: vi.fn(async () => who.build()), update } };
    await expect(
      addBoundKey(handleWith(sdk), {
        identityId: who.identityId,
        masterWif: who.auth.wif,
        spec: JOIN_ENCRYPTION,
        newKey: generateKey(mod, 'testnet'),
      }),
    ).rejects.toThrow(/not this identity's master key/);
    await expect(
      addBoundKey(handleWith(sdk), {
        identityId: who.identityId,
        masterWif: generateKey(mod, 'mainnet').wif,
        spec: JOIN_ENCRYPTION,
        newKey: generateKey(mod, 'testnet'),
      }),
    ).rejects.toThrow(/mainnet key/);
    expect(update).not.toHaveBeenCalled();
  });

  it('should size an encrypted join message as IV plus padded blocks', () => {
    expect(encryptedSize(0)).toBe(32);
    expect(encryptedSize(15)).toBe(32);
    expect(encryptedSize(16)).toBe(48);
    expect(encryptedSize(1023)).toBe(1040);
  });
});

describe('document writes (mocked SDK)', () => {
  const signer = (identityId: string): DocumentSigner =>
    ({ identityId, identityKey: {}, signer: {} }) as unknown as DocumentSigner;

  it('should file a reason and confirm it by reading it back', async () => {
    const leader = id32(9);
    const create = vi.fn(async (opts: { document: InstanceType<typeof mod.Document>; contestFund?: bigint }) => {
      expect(opts.document.properties).toEqual({ code: 'SPM', label: 'Spam' });
      expect(opts.contestFund).toBeUndefined();
      return { id: { toBase58: () => id32(1) } };
    });
    const sdk = {
      documents: { create, get: vi.fn(async () => ({ ownerId: { toBase58: () => leader } })) },
    };
    const outcome = await fileReason(handleWith(sdk), signer(leader), { code: 'SPM', label: ' Spam ' });
    expect(outcome).toEqual({ status: 'confirmed', value: id32(1) });
    expect(sdk.documents.get).toHaveBeenCalledWith(CHARTERS_CONTRACT_ID, 'reason', id32(1));
  });

  it('should refuse to build an invalid reason', async () => {
    await expect(fileReason(handleWith({}), signer(id32(9)), { code: 'spam', label: 'x' })).rejects.toThrow(/three capital/);
  });

  /** A vote state with the given contenders, as rc.4 returns it. */
  const voteState = (ids: string[]) => ({
    contenders: ids.map((identityId) => ({ identityId, voteTally: 0 })),
    abstainVoteTally: 0,
    lockVoteTally: 0,
  });

  it('should apply with the 0.5 DASH contest fund and confirm by finding the leader among the contenders', async () => {
    const leader = id32(9);
    let applied = false;
    const sdk = {
      version: () => 14,
      contracts: { fetch: vi.fn(async () => undefined) },
      documents: {
        create: vi.fn(async (opts: { contestFund?: bigint }) => {
          expect(opts.contestFund).toBe(MODERATION_CONTEST_FUND);
          applied = true;
          return {};
        }),
      },
      voting: { contestedResourceVoteState: vi.fn(async () => voteState(applied ? [leader] : [])) },
    };
    const application = buildApplication(mod, { targetContractId: TARGET, leaderId: leader, submittedCharterId: id32(5), members: [] });
    try {
      const outcome = await applyForSeat(handleWith(sdk), signer(leader), application, TARGET);
      expect(outcome).toEqual({ status: 'confirmed', value: leader });
      expect(dashText(MODERATION_CONTEST_FUND)).toBe('0.5 DASH');
    } finally {
      application.free();
    }
  });

  it('should report a late application in plain words', async () => {
    const leader = id32(8);
    const sdk = {
      documents: {
        create: vi.fn(async () => {
          throw { message: 'Document contest not joinable', code: 40111 };
        }),
      },
    };
    const application = buildApplication(mod, { targetContractId: TARGET, leaderId: leader, submittedCharterId: id32(5), members: [] });
    try {
      const outcome = await applyForSeat(handleWith(sdk), signer(leader), application, TARGET);
      expect(outcome).toEqual({
        status: 'refused',
        error: { code: 40111, message: REFUSALS[40111], detail: 'Document contest not joinable' },
      });
    } finally {
      application.free();
    }
  });
});
