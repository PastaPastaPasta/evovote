/**
 * Opt-in, read-only check of the discussion contract on testnet
 * (`npm run test:live`). Skipped until VITE_DISCUSSION_TESTNET_CONTRACT_ID
 * names a published contract. Nothing here signs or broadcasts.
 */
import type { EvoSDK } from '@dashevo/evo-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { discussionContractId } from '../discussion/config';
import { fetchComments, fetchLatestByAuthor } from '../discussion/reads';
import { scopeOf } from '../discussion/scope';
import { text } from '../model/indexValue';
import type { PollKey } from '../model/pollKey';

const contractId = discussionContractId('testnet');
// An identity that owns a DPNS name on testnet; the author index is queried for it.
const AUTHOR = '9idHpqmf8i9U6tfWiWMQCVF39vshNgYisT7DL6yK2pCF';
const key: PollKey = {
  contractId: 'GWRSAV8CpSLfRDJFDoycW5yuDVzs6dM8sYYLmGLmS31Ec',
  documentTypeName: 'domain',
  indexName: 'parentNameAndLabel',
  indexValues: [text('dash'), text('evovote-discussion-probe')],
};

let sdk: EvoSDK;

describe('(prop, $createdAt) index queries on testnet (the shape comments use)', () => {
  // DashPay's contactRequest has the same kind of index as the comment's `author`
  // index: ownerIdCreatedAt = ($ownerId, $createdAt). Pins the query shape
  // fetchComments relies on: where == on the first property, orderBy
  // [prop asc, $createdAt asc|desc], startAfter a document id.
  const DASHPAY = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7';
  type Row = { id: string; owner: string; t: number };
  const rows = async (extra: Record<string, unknown>): Promise<Row[]> => {
    const page = await sdk.documents.query({
      dataContractId: DASHPAY,
      documentTypeName: 'contactRequest',
      ...extra,
    } as Parameters<EvoSDK['documents']['query']>[0]);
    return [...page.values()].map((d) => {
      try {
        return { id: d!.id.toBase58(), owner: d!.ownerId.toBase58(), t: Number(d!.createdAt) };
      } finally {
        d!.free();
      }
    });
  };

  beforeAll(async () => {
    const mod = await import('@dashevo/evo-sdk');
    sdk = mod.EvoSDK.testnetTrusted({ settings: { timeoutMs: 30_000 } });
    await sdk.connect();
  });

  it('should order newest first with orderBy $createdAt desc, and page with startAfter', async () => {
    const [first] = await rows({
      where: [['$ownerId', '>', '11111111111111111111111111111111']],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
      limit: 1,
    });
    expect(first).toBeTruthy();
    const where = [['$ownerId', '==', first.owner]];
    const asc = await rows({ where, orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 10 });
    const desc = await rows({ where, orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 10 });
    expect(desc.map((r) => r.id)).toEqual(asc.map((r) => r.id).reverse());
    if (desc.length > 1) {
      const next = await rows({
        where,
        orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
        limit: 10,
        startAfter: desc[0].id,
      });
      expect(next.map((r) => r.id)).toEqual(desc.slice(1).map((r) => r.id));
    }
  });
});

describe.skipIf(!contractId)('discussion contract on testnet (read-only)', () => {
  it('should publish the comment type with the scope and author indices', async () => {
    const contract = await sdk.contracts.fetch(contractId as string);
    expect(contract).toBeTruthy();
    const json = contract!.toJSON(sdk.version()).documentSchemas.comment as {
      indices: Array<{ properties: Array<Record<string, string>> }>;
      properties: Record<string, { maxLength?: number }>;
    };
    expect(json.indices.map((i) => i.properties.map((p) => Object.keys(p)[0]))).toEqual([
      ['scope', '$createdAt'],
      ['$ownerId', '$createdAt'],
    ]);
    expect(json.properties.scope.maxLength).toBe(43);
  });

  it('should query a contest in both orders without error (an unused scope is empty)', async () => {
    for (const order of ['newest', 'oldest'] as const) {
      const page = await fetchComments(sdk, contractId as string, key, { order, pageSize: 5 });
      expect(page.comments).toBeInstanceOf(Array);
      expect(page.hidden).toBe(0);
    }
    expect((await scopeOf(key)).scope).toHaveLength(43);
  });

  it('should query the author index', async () => {
    await expect(fetchLatestByAuthor(sdk, contractId as string, AUTHOR, 5)).resolves.toBeInstanceOf(Array);
  });
});
