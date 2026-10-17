/**
 * Discussion: the contract, scope hashing, the reader and the writer, with
 * real wasm objects and throwaway keys against a mocked SDK. Nothing here
 * touches the network or broadcasts.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as mod from '@dashevo/evo-sdk';
import type { EvoSDK } from '@dashevo/evo-sdk';
import schemas from '../../contracts/discussion.json';
import { generateKey } from '../identity/update';
import type { DocumentSigner } from '../identity/session';
import { base58Decode, base58Encode, bytesToBase64Url } from '../model/bytes';
import { identifier, text, type IndexValue } from '../model/indexValue';
import { encodePollKey, type PollKey } from '../model/pollKey';
import type { SdkHandle } from '../sdk/connection';
import { discussionContractId, parseContractId } from './config';
import { displayText } from './text';
import { fetchComments, readComment } from './reads';
import { POLL_KEY_MAX_LENGTH, SCOPE_LENGTH, scopeOf, scopeOfKeyString } from './scope';
import {
  COMMENT_LIMIT,
  commentLength,
  commentProperties,
  estimateComment,
  newCommentDocument,
  postComment,
  validateDraft,
} from './writes';

const id32 = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const OWNER = id32(1);
const AUTHOR = id32(7);
const OTHER = id32(8);
const CONTRACT_ID = id32(42);
const dpnsKey: PollKey = {
  contractId: id32(3),
  documentTypeName: 'domain',
  indexName: 'parentNameAndLabel',
  indexValues: [text('dash'), text('alice')],
};

beforeAll(async () => {
  await mod.ensureInitialized();
});

const makeContract = () =>
  new mod.DataContract({ ownerId: OWNER, identityNonce: 1n, schemas, fullValidation: true });

const sdkWith = (sdk: unknown): EvoSDK => sdk as EvoSDK;
const handleWith = (sdk: unknown): SdkHandle => ({ sdk: sdkWith(sdk), mod, network: 'testnet' });

describe('contracts/discussion.json', () => {
  it('should pass DPP schema validation, including the indexed-property limits', () => {
    const contract = makeContract();
    try {
      expect(contract.id.toString()).toBeTruthy();
      const json = contract.toJSON(14).documentSchemas.comment as Record<string, unknown>;
      expect(json.documentsMutable).toBe(false);
      expect(json.canBeDeleted).toBe(false);
    } finally {
      contract.free();
    }
  });

  it('should index comments by (scope, $createdAt) and by ($ownerId, $createdAt)', () => {
    const indices = schemas.comment.indices.map((i) => i.properties.map((p) => Object.keys(p)[0]));
    expect(indices).toEqual([
      ['scope', '$createdAt'],
      ['$ownerId', '$createdAt'],
    ]);
  });

  it('should index a fixed-size hash, never the (too long) canonical key', () => {
    const props = schemas.comment.properties;
    // Platform caps an indexed string at 63 characters.
    expect(props.scope.maxLength).toBe(SCOPE_LENGTH);
    expect(props.scope.maxLength).toBeLessThanOrEqual(63);
    expect(props.pollKey.maxLength).toBe(POLL_KEY_MAX_LENGTH);
    const indexed = new Set(schemas.comment.indices.flatMap((i) => i.properties.flatMap((p) => Object.keys(p))));
    expect(indexed.has('pollKey')).toBe(false);
    expect(indexed.has('supports')).toBe(false);
    expect(schemas.comment.required).toContain('scope');
    expect(schemas.comment.required).not.toContain('supports');
  });

  it('should fit the longest key a contested index can produce', () => {
    // contract id 44, document type name <= 64, index name <= 32, an index has
    // <= 10 properties and a string index value is <= 63 characters.
    const longest: PollKey = {
      contractId: id32(250),
      documentTypeName: 'd'.repeat(64),
      indexName: 'i'.repeat(32),
      indexValues: Array.from({ length: 10 }, (_, i) => text(String.fromCharCode(97 + i).repeat(63))),
    };
    expect(longest.contractId).toHaveLength(44);
    expect(encodePollKey(longest).length).toBeLessThanOrEqual(POLL_KEY_MAX_LENGTH);
    // 10 identifiers, as a charter-like index would carry, are shorter still.
    const ids: IndexValue[] = Array.from({ length: 10 }, (_, i) => identifier(id32(i + 1)));
    expect(encodePollKey({ ...longest, indexValues: ids }).length).toBeLessThanOrEqual(POLL_KEY_MAX_LENGTH);
  });

  it('should keep the realistic keys far under the limit', () => {
    expect(encodePollKey(dpnsKey).length).toBeLessThan(200);
  });
});

describe('scope', () => {
  it('should be the base64url SHA-256 of the canonical key string', async () => {
    const { scope, pollKey } = await scopeOf(dpnsKey);
    expect(pollKey).toBe(encodePollKey(dpnsKey));
    expect(scope).toHaveLength(SCOPE_LENGTH);
    expect(scope).toMatch(new RegExp(schemas.comment.properties.scope.pattern));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pollKey)));
    expect(scope).toBe(bytesToBase64Url(digest));
  });

  it('should match a known vector', async () => {
    // sha256("abc") = ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad
    expect((await scopeOfKeyString('abc')).scope).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it('should differ per contest and be stable for one', async () => {
    const a = await scopeOf(dpnsKey);
    const b = await scopeOf({ ...dpnsKey, indexValues: [text('dash'), text('alicf')] });
    expect(a.scope).not.toBe(b.scope);
    expect((await scopeOf({ ...dpnsKey })).scope).toBe(a.scope);
  });

  it('should refuse a key longer than the contract allows', async () => {
    const huge: PollKey = { ...dpnsKey, indexValues: [text('x'.repeat(63)), ...Array.from({ length: 40 }, () => text('y'.repeat(63)))] };
    await expect(scopeOf(huge)).rejects.toThrow('too long');
  });
});

describe('config', () => {
  it('should read the id per network and treat missing or malformed as not activated', () => {
    const env = { VITE_DISCUSSION_TESTNET_CONTRACT_ID: ` ${CONTRACT_ID} `, VITE_DISCUSSION_MAINNET_CONTRACT_ID: 'nope' };
    expect(discussionContractId('testnet', env)).toBe(CONTRACT_ID);
    expect(discussionContractId('mainnet', env)).toBeUndefined();
    expect(discussionContractId('testnet', {})).toBeUndefined();
    expect(parseContractId('')).toBeUndefined();
    expect(parseContractId(undefined)).toBeUndefined();
  });
});

describe('text', () => {
  it('should drop control and bidi override characters and cap blank runs', () => {
    expect(displayText('a\u0000b‮c⁦d')).toBe('abcd');
    expect(displayText('x\r\n\r\n\r\n\r\ny')).toBe('x\n\ny');
    expect(displayText('  tab\there\n')).toBe('tab\there');
  });
  it('should leave markup alone (it is escaped at render time)', () => {
    expect(displayText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });
});

// ---- reader ------------------------------------------------------------------

/** A comment document as Platform returns it, with a chosen id. */
function commentDoc(opts: {
  n: number;
  pollKey: string;
  scope?: string;
  body?: string;
  replyTo?: string;
  supports?: string;
  createdAt?: bigint;
  owner?: string;
}) {
  const doc = mod.Document.fromObject(
    {
      $formatVersion: '0',
      $id: new Uint8Array(32).fill(100 + opts.n),
      $ownerId: base58Decode(opts.owner ?? AUTHOR),
      $dataContractId: base58Decode(id32(2)),
      $type: 'comment',
      $entropy: new Uint8Array(32),
      $createdAt: opts.createdAt ?? BigInt(1_700_000_000_000 + opts.n),
      scope: opts.scope ?? 's'.repeat(43),
      pollKey: opts.pollKey,
      body: opts.body ?? `comment ${opts.n}`,
      ...(opts.replyTo ? { replyTo: base58Decode(opts.replyTo) } : {}),
      ...(opts.supports ? { supports: base58Decode(opts.supports) } : {}),
    } as unknown as Parameters<typeof mod.Document.fromObject>[0],
    mod.PlatformVersion.latest(),
  );
  return doc;
}

describe('reader', () => {
  const CONTRACT = id32(2);

  it('should query by scope, newest first by default, and page with startAfter', async () => {
    const key = encodePollKey(dpnsKey);
    const page = new Map(Array.from({ length: 3 }, (_, i) => [`k${i}`, commentDoc({ n: i, pollKey: key })]));
    const query = vi.fn().mockResolvedValue(page);
    const result = await fetchComments(sdkWith({ documents: { query } }), CONTRACT, dpnsKey, { startAfter: id32(9), pageSize: 3 });
    const arg = query.mock.calls[0][0];
    expect(arg).toMatchObject({
      dataContractId: CONTRACT,
      documentTypeName: 'comment',
      where: [['scope', '==', (await scopeOf(dpnsKey)).scope]],
      orderBy: [['scope', 'asc'], ['$createdAt', 'desc']],
      limit: 3,
      startAfter: id32(9),
    });
    expect(result.comments).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe(base58Encode(new Uint8Array(32).fill(102)));
    expect(result.comments[0]).toMatchObject({ ownerId: AUTHOR, body: 'comment 0', createdAtMs: 1_700_000_000_000 });
  });

  it('should ask for oldest first on request, and report the last page', async () => {
    const query = vi.fn().mockResolvedValue(new Map());
    const result = await fetchComments(sdkWith({ documents: { query } }), CONTRACT, dpnsKey, { order: 'oldest' });
    expect(query.mock.calls[0][0].orderBy).toEqual([['scope', 'asc'], ['$createdAt', 'asc']]);
    expect(query.mock.calls[0][0]).not.toHaveProperty('startAfter');
    expect(result).toMatchObject({ comments: [], hasMore: false, hidden: 0 });
  });

  it('should read reply and supports ids and hide documents naming another contest', async () => {
    const key = encodePollKey(dpnsKey);
    const page = new Map([
      ['a', commentDoc({ n: 1, pollKey: key, replyTo: id32(5), supports: OTHER })],
      ['b', commentDoc({ n: 2, pollKey: key + 'x' })],
    ]);
    const query = vi.fn().mockResolvedValue(page);
    const result = await fetchComments(sdkWith({ documents: { query } }), CONTRACT, dpnsKey);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({ replyTo: id32(5), supports: OTHER, pollKey: key });
    expect(result.hidden).toBe(1);
    // The cursor advances past hidden documents too, so paging cannot stall.
    expect(result.cursor).toBe(base58Encode(new Uint8Array(32).fill(102)));
    expect(result.hasMore).toBe(false);
  });

  it('should reject a document with a non-string body', () => {
    const doc = commentDoc({ n: 1, pollKey: 'k' });
    expect(readComment({ id: doc.id, ownerId: doc.ownerId, createdAt: 1n, properties: { body: 5, pollKey: 'k' } }, 'k')).toBeUndefined();
    doc.free();
  });
});

// ---- writer ------------------------------------------------------------------

describe('writer', () => {
  /** Read-back attempts without the real pauses. */
  const FAST = { attempts: 3, delayMs: 1 };

  it('should validate length by characters, trimmed', () => {
    expect(validateDraft({ body: '   ' })).toHaveLength(1);
    expect(validateDraft({ body: 'x'.repeat(COMMENT_LIMIT) })).toEqual([]);
    expect(validateDraft({ body: 'x'.repeat(COMMENT_LIMIT + 1) })).toHaveLength(1);
    // Emoji count once, as the contract's maxLength does.
    expect(validateDraft({ body: '😀'.repeat(COMMENT_LIMIT) })).toEqual([]);
    expect(commentLength('😀😀')).toBe(2);
    expect(validateDraft({ body: 'hi', replyTo: 'bad' })).toHaveLength(1);
    expect(validateDraft({ body: 'hi', supports: 'bad' })).toHaveLength(1);
  });

  it('should build properties with identifiers as bytes and nothing extra', async () => {
    const scope = await scopeOf(dpnsKey);
    const props = commentProperties(scope, { body: '  hello  ', replyTo: id32(5), supports: OTHER });
    expect(props).toEqual({
      scope: scope.scope,
      pollKey: scope.pollKey,
      body: 'hello',
      replyTo: new Uint8Array(32).fill(5),
      supports: base58Decode(OTHER),
    });
    expect(Object.keys(commentProperties(scope, { body: 'x' }))).toEqual(['scope', 'pollKey', 'body']);
    expect(() => commentProperties(scope, { body: '' })).toThrow();
  });

  it('should serialize against the contract, keeping binary ids, at the length limits', async () => {
    const contract = makeContract();
    const version = mod.PlatformVersion.latest();
    try {
      const scope = await scopeOf(dpnsKey);
      const props = commentProperties(scope, { body: '😀'.repeat(COMMENT_LIMIT), replyTo: id32(5), supports: OTHER });
      const doc = newCommentDocument(mod, contract.id.toString(), AUTHOR, props);
      const decoded = mod.Document.fromBytes(doc.toBytes(contract, version), contract, 'comment', version);
      const json = decoded.toJSON(version) as Record<string, unknown>;
      expect(json.scope).toBe(scope.scope);
      expect(json.pollKey).toBe(scope.pollKey);
      expect(Array.from(json.body as string)).toHaveLength(COMMENT_LIMIT);
      expect(decoded.ownerId.toBase58()).toBe(AUTHOR);
      expect(readComment(decoded, scope.pollKey)).toMatchObject({ replyTo: id32(5), supports: OTHER, ownerId: AUTHOR });
      [doc, decoded].forEach((d) => d.free());
    } finally {
      contract.free();
      version.free();
    }
  });

  it('should price a comment offline from the contract, dearer for a longer one', async () => {
    const contract = makeContract();
    const contractId = contract.id.toString();
    const sdk = { contracts: { fetch: async () => contract }, version: () => 14 };
    const handle = handleWith(sdk);
    const scope = await scopeOf(dpnsKey);
    const short = await estimateComment(handle, contractId, scope, { body: 'hi' });
    const long = await estimateComment(handle, contractId, scope, { body: 'x'.repeat(2000) });
    const reply = await estimateComment(handle, contractId, scope, { body: 'hi', replyTo: id32(5), supports: OTHER });
    expect(short.fees).toBeGreaterThan(0n);
    expect(short.contestFund).toBe(0n);
    expect(long.total).toBeGreaterThan(short.total);
    expect(reply.total).toBeGreaterThan(short.total);
  });

  /** A throwaway signer: the key is generated here and never leaves the test. */
  function throwawaySigner(identityId: string): { signer: DocumentSigner; free(): void } {
    const key = generateKey(mod, 'testnet');
    const identityKey = new mod.IdentityPublicKey({
      keyId: 1,
      purpose: 'authentication',
      securityLevel: 'high',
      keyType: 'ecdsa_secp256k1',
      isReadOnly: false,
      data: Uint8Array.from(key.publicKeyHex.match(/../g)!.map((h) => parseInt(h, 16))),
    });
    const privateKey = mod.PrivateKey.fromHex(key.privateKeyHex, 'testnet');
    const idSigner = new mod.IdentitySigner();
    idSigner.addKey(privateKey);
    return {
      signer: { identityId, identityKey, signer: idSigner },
      free: () => [identityKey, privateKey, idSigner].forEach((o) => o.free()),
    };
  }

  it('should create the comment, sign with the key given, and confirm by reading it back', async () => {
    const CONTRACT = id32(2);
    const scope = await scopeOf(dpnsKey);
    const { signer, free } = throwawaySigner(AUTHOR);
    const createdId = new Uint8Array(32).fill(150);
    const documents = {
      query: vi.fn().mockResolvedValue(new Map()),
      create: vi.fn().mockImplementation(async (opts: { document: InstanceType<typeof mod.Document>; identityKey: unknown; signer: unknown }) => {
        expect(opts.identityKey).toBe(signer.identityKey);
        expect(opts.signer).toBe(signer.signer);
        // The document as it is sent.
        const p = opts.document.properties;
        expect(p.scope).toBe(scope.scope);
        expect(p.pollKey).toBe(scope.pollKey);
        expect(p.body).toBe('Backing alice');
        expect(opts.document.ownerId.toBase58()).toBe(AUTHOR);
        return { id: { toBase58: () => base58Encode(createdId) }, free() {} };
      }),
      // The read-back finds the document under the id create reported.
      get: vi.fn().mockImplementation(async (_c: string, _t: string, id: string) =>
        id === base58Encode(createdId)
          ? commentDoc({ n: 50, pollKey: scope.pollKey, scope: scope.scope, body: 'Backing alice', supports: OTHER })
          : null,
      ),
    };
    documents.get.mockImplementationOnce(async () => null); // first read-back: not visible yet
    const outcome = await postComment(handleWith({ documents }), signer, CONTRACT, dpnsKey, { body: ' Backing alice ', supports: OTHER }, FAST);
    expect(documents.create).toHaveBeenCalledOnce();
    expect(outcome.status).toBe('confirmed');
    if (outcome.status === 'confirmed') expect(outcome.value).toMatchObject({ body: 'Backing alice', supports: OTHER, ownerId: AUTHOR });
    free();
  });

  it('should not report a different document under the same id as confirmed', async () => {
    const scope = await scopeOf(dpnsKey);
    const { signer, free } = throwawaySigner(AUTHOR);
    const documents = {
      query: vi.fn().mockResolvedValue(new Map()),
      create: vi.fn().mockResolvedValue({ id: { toBase58: () => id32(150) }, free() {} }),
      get: vi.fn().mockImplementation(async () => commentDoc({ n: 1, pollKey: scope.pollKey, body: 'something else' })),
    };
    const outcome = await postComment(handleWith({ documents }), signer, id32(2), dpnsKey, { body: 'mine' }, FAST);
    // Never confirmed: the read-back does not match what was written.
    expect(outcome.status).toBe('pending');
    free();
  });

  it('should refuse a reply to a comment of another contest before signing anything', async () => {
    const { signer, free } = throwawaySigner(AUTHOR);
    const documents = {
      query: vi.fn().mockResolvedValue(new Map()),
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(commentDoc({ n: 1, pollKey: 'some other contest' })),
    };
    await expect(
      postComment(handleWith({ documents }), signer, id32(2), dpnsKey, { body: 'hi', replyTo: id32(101) }),
    ).rejects.toThrow('not in this discussion');
    expect(documents.create).not.toHaveBeenCalled();
    free();
  });

  it('should report a consensus refusal without reading back', async () => {
    const { signer, free } = throwawaySigner(AUTHOR);
    const refusal = Object.assign(new Error('document type is immutable'), { code: 40105 });
    const documents = {
      query: vi.fn().mockResolvedValue(new Map()),
      create: vi.fn().mockRejectedValue(refusal),
      get: vi.fn(),
    };
    const outcome = await postComment(handleWith({ documents }), signer, id32(2), dpnsKey, { body: 'hi' });
    expect(outcome.status).toBe('refused');
    expect(documents.get).not.toHaveBeenCalled();
    free();
  });

  it('should sign a create batch for a comment with a throwaway key', async () => {
    const key = generateKey(mod, 'testnet');
    const scope = await scopeOf(dpnsKey);
    const doc = newCommentDocument(mod, id32(2), AUTHOR, commentProperties(scope, { body: 'signed' }));
    const transition = new mod.DocumentCreateTransition({ document: doc, identityContractNonce: 1n });
    const batch = mod.BatchTransition.fromBatchedTransitions(
      [new mod.BatchedTransition(transition.toDocumentTransition())],
      AUTHOR,
      0,
    );
    const st = batch.toStateTransition();
    const privateKey = mod.PrivateKey.fromHex(key.privateKeyHex, 'testnet');
    const identityKey = new mod.IdentityPublicKey({
      keyId: 1,
      purpose: 'authentication',
      securityLevel: 'high',
      keyType: 'ecdsa_secp256k1',
      isReadOnly: false,
      data: Uint8Array.from(key.publicKeyHex.match(/../g)!.map((h) => parseInt(h, 16))),
    });
    try {
      st.sign(privateKey, identityKey);
      expect(st.signature?.length).toBe(65);
    } finally {
      [st, batch, transition, doc, privateKey, identityKey].forEach((o) => o.free());
    }
  });
});
