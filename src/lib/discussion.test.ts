import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as mod from '@dashevo/evo-sdk';
import * as secp256k1 from '@noble/secp256k1';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import schemas from '../../contracts/discussion.json';
import { buildCommentDocument, commentConfirmed, commentProperties, fetchComments, prepareComment, publishComment } from './discussion';
import { loginWithKey, usableAuthKey, type DiscussionSession } from './discussion-auth';
import { base58Decode, base58Encode } from './keys';
import { checkWalletLogin, platformBytes, stateTransitionUri, walletLoginRequest } from './wallet';
import type { SdkHandle } from './sdk';

const ownerId = base58Encode(new Uint8Array(32).fill(1));
const contractId = base58Encode(new Uint8Array(32).fill(2));
const parentId = base58Encode(new Uint8Array(32).fill(3));
const session: DiscussionSession = { identityId: ownerId, keyId: 1, mode: 'wallet' };
const handleWith = (sdk: unknown): SdkHandle => ({ mod, sdk: sdk as SdkHandle['sdk'] });
beforeAll(async () => { await mod.ensureInitialized(); });

function publicKey(overrides: Partial<mod.IdentityPublicKeyOptions> = {}) {
  return new mod.IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'high',
    keyType: 'ecdsa_hash160', isReadOnly: false, data: new Uint8Array(20), ...overrides });
}

function comment(body = 'A useful comment', replyTo?: string) {
  const doc = new mod.Document({ ownerId, dataContractId: contractId, documentTypeName: 'comment',
    properties: commentProperties('test', body, replyTo) });
  doc.createdAt = 1700000000000n;
  return doc;
}

describe('discussion contract and state transitions', () => {
  it('passes actual DPP schema validation', () => {
    const contract = new mod.DataContract({ ownerId, identityNonce: 1n, schemas, fullValidation: true });
    expect(contract.id.toString()).toBeTruthy();
    contract.free();
  });

  it('preserves binary reply IDs through schema serialization (constructor regression)', () => {
    const contract = new mod.DataContract({ ownerId, identityNonce: 1n, schemas, fullValidation: true });
    const document = buildCommentDocument(mod, contract.id.toString(), ownerId, commentProperties('test', 'Reply', parentId));
    const version = mod.PlatformVersion.current();
    const decoded = mod.Document.fromBytes(document.toBytes(contract, version), contract, 'comment', version);
    expect(decoded.properties.replyTo).toEqual(base58Decode(parentId));
    decoded.free(); document.free(); contract.free(); version.free();
  });

  it('builds a decodable unsigned batch with the expected owner, key and fresh nonce', async () => {
    const handle = handleWith({ identities: { contractNonce: vi.fn().mockResolvedValue(6n) } });
    const prepared = await prepareComment(handle, contractId, session, 'test', ' A useful comment ');
    const state = mod.StateTransition.fromBytes(prepared.bytes);
    const batch = mod.BatchTransition.fromStateTransition(state);
    try {
      expect(state.signature?.length ?? 0).toBe(0);
      expect(state.signaturePublicKeyId).toBe(1);
      expect(state.ownerId?.toString()).toBe(ownerId);
      expect(state.identityContractNonce).toBe(7n);
      expect(batch.modifiedDataIds.map(id => id.toString())).toContain(prepared.id);
      expect(prepared.body).toBe('A useful comment');
      expect(stateTransitionUri(prepared.bytes, 'testnet')).toMatch(/^dash-st:.+\?n=t&v=1$/);
    } finally { batch.free(); state.free(); }
  });

  it('supports a first write and refuses cross-contest replies', async () => {
    const handle = handleWith({ identities: { contractNonce: vi.fn().mockResolvedValue(undefined) } });
    const prepared = await prepareComment(handle, contractId, session, 'test', 'First');
    const state = mod.StateTransition.fromBytes(prepared.bytes);
    expect(state.identityContractNonce).toBe(1n);
    state.free();
    const parent = comment();
    await expect(prepareComment(handleWith({ documents: { get: vi.fn().mockResolvedValue(parent) } }),
      contractId, session, 'other', 'Reply', parentId)).rejects.toThrow('belong to this contest');
  });

  it('reads reply IDs and timestamps from real WASM documents and retains the pagination cursor', async () => {
    const query = vi.fn().mockImplementation(async () => new Map([['doc', comment('Reply', parentId)]]));
    const result = await fetchComments(handleWith({ documents: { query } }), contractId, 'test', parentId);
    expect(result.comments[0]).toMatchObject({ replyTo: parentId, createdAt: 1700000000000, body: 'Reply' });
    expect(query.mock.calls[0][0]).toMatchObject({ startAfter: parentId, limit: 30 });
  });

  it('requires the expected content and author before confirming', async () => {
    const doc = comment();
    const prepared = { id: doc.id.toString(), ownerId, contest: 'test', body: 'Different', bytes: new Uint8Array() };
    expect(await commentConfirmed(handleWith({ documents: { get: vi.fn().mockResolvedValue(doc) } }), contractId, prepared)).toBe(false);
    const reply = comment('Reply', parentId);
    expect(await commentConfirmed(handleWith({ documents: { get: vi.fn().mockResolvedValue(reply) } }), contractId,
      { ...prepared, id: reply.id.toString(), body: 'Reply', replyTo: parentId })).toBe(true);
  });

  it('rejects invalid input and handles Unicode length', () => {
    expect(() => commentProperties('test', '  ')).toThrow();
    expect(() => commentProperties('test', 'x'.repeat(2001))).toThrow();
    expect(() => commentProperties('../test', 'hello')).toThrow();
    expect(() => commentProperties('test', 'hello', 'bad')).toThrow();
    expect(commentProperties('test', '😀'.repeat(2000)).body).toHaveLength(4000);
  });
});

describe('authentication boundaries', () => {
  it('rejects disabled, master, voting and insufficient-security keys', () => {
    for (const options of [{ purpose: 'voting' }, { securityLevel: 'master' }, { securityLevel: 'medium' }] as const) {
      const key = publicKey(options); expect(usableAuthKey(key)).toBe(false); key.free();
    }
    const disabled = publicKey(); disabled.disabledAt = 1n;
    expect(usableAuthKey(disabled)).toBe(false); disabled.free();
  });

  it('discovers an identity from its public key hash and signs the same prepared batch', async () => {
    const privateKey = mod.PrivateKey.fromHex('01'.padStart(64, '0'), 'testnet');
    const key = publicKey({ data: Uint8Array.from(privateKey.getPublicKeyHash().match(/../g)!, byte => parseInt(byte, 16)) });
    const makeIdentity = () => { const identity = new mod.Identity(ownerId); identity.addPublicKey(key); return identity; };
    const byPublicKeyHash = vi.fn().mockImplementation(async () => makeIdentity());
    const broadcastAndWait = vi.fn().mockImplementation(async (state: mod.StateTransition) => {
      expect(state.signature?.length).toBe(65);
      expect(state.ownerId?.toString()).toBe(ownerId);
      expect(state.signaturePublicKeyId).toBe(1);
    });
    const handle = handleWith({ identities: { byPublicKeyHash, fetch: async () => makeIdentity(), contractNonce: async () => 0n },
      stateTransitions: { broadcastAndWait } });
    const [found] = await loginWithKey(handle, 'testnet', privateKey.toHex());
    expect(byPublicKeyHash).toHaveBeenCalledWith(privateKey.getPublicKeyHash());
    expect(found.identityId).toBe(ownerId);
    const prepared = await prepareComment(handle, contractId, found, 'test', 'Signed');
    await publishComment(handle, found, prepared);
    expect(broadcastAndWait).toHaveBeenCalledOnce();
    found.privateKey?.free(); key.free(); privateKey.free();
  });

  it('does not send a private key or a malformed WIF to a lookup', async () => {
    const lookup = vi.fn();
    const handle = handleWith({ identities: { byPublicKeyHash: lookup } });
    await expect(loginWithKey(handle, 'testnet', 'invalid')).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('Yappr wallet wire compatibility', () => {
  it('packs a versioned request with the application contract and network', () => {
    const request = walletLoginRequest(contractId, 'mainnet');
    const bytes = base58Decode(request.uri.slice(9).split('?')[0]);
    expect(bytes[0]).toBe(1);
    expect(base58Encode(bytes.slice(34, 66))).toBe(contractId);
    expect(new TextDecoder().decode(bytes.slice(67))).toBe('Login to EvoVote');
    expect(request.uri).toContain('?n=m&v=1');
    request.secret.fill(0);
  });
  it('normalizes SDK binary fields without accepting truncated or wrapped values', () => {
    expect(platformBytes([1n, 2n], 2)).toEqual(new Uint8Array([1, 2]));
    expect(() => platformBytes([256, 0], 2)).toThrow();
    expect(() => platformBytes([1], 2)).toThrow();
  });
});


it('discovers a wallet identity only from a decryptable Platform response', async () => {
  const request = walletLoginRequest(contractId, 'testnet');
  const requestBytes = base58Decode(request.uri.slice(9).split('?')[0]);
  const walletSecret = secp256k1.utils.randomSecretKey();
  const walletPublic = secp256k1.getPublicKey(walletSecret, true);
  const sharedPoint = secp256k1.getSharedSecret(walletSecret, requestBytes.slice(1, 34));
  const shared = hkdf(sha256, sharedPoint.slice(1, 33), new TextEncoder().encode('dash:key-exchange:v1'), new Uint8Array(), 32);
  const aes = await crypto.subtle.importKey('raw', shared as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new Uint8Array(32).fill(9)));
  const payload = new Uint8Array(60); payload.set(iv); payload.set(encrypted, 12);
  const response = () => new mod.Document({ ownerId, dataContractId: contractId, documentTypeName: 'loginKeyResponse', properties: {
    walletEphemeralPubKey: walletPublic, encryptedPayload: payload,
  } });
  const query = vi.fn().mockImplementation(async () => new Map([['response', response()]]));
  expect(await checkWalletLogin(handleWith({ documents: { query } }), contractId, contractId, request)).toBe(ownerId);
  expect(query.mock.calls[0][0].where).toEqual([['contractId', '==', contractId], ['appEphemeralPubKeyHash', '==', btoa(String.fromCharCode(...request.publicKeyHash))]]);
  payload[59] ^= 1;
  await expect(checkWalletLogin(handleWith({ documents: { query } }), contractId, contractId, request)).rejects.toThrow();
  request.secret.fill(0); walletSecret.fill(0); shared.fill(0); sharedPoint.fill(0);
});
