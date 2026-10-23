import type { EvoSDK } from '@dashevo/evo-sdk';
import { describe, expect, it, vi } from 'vitest';
import { KNOWN_CONTRACTS, knownContractById } from '../config/knownContracts';
import { base58Decode, base58Encode } from '../model/bytes';
import {
  collectDirectoryIds,
  contractAbout,
  directoryGroup,
  directoryNote,
  discoverDirectory,
  forgetDirectory,
  hiddenFromDirectory,
  MAX_DISCOVERED_TARGETS,
  mergeDirectory,
  walkDistinctTargets,
} from './directory';
import type { ElectionPhase } from './phase';

const id32 = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const [A, B, C, D] = [1, 2, 3, 4].map(id32);

/** A fake ordered index: one entry per document, target order; a page is the documents of the targets after `after`. */
function fakeIndex(docs: string[], pageSize: number) {
  const calls: Array<string | undefined> = [];
  const fetchPage = async (after: string | undefined) => {
    calls.push(after);
    const from = after === undefined ? 0 : docs.findIndex((t) => t > after);
    return from < 0 ? [] : docs.slice(from, from + pageSize);
  };
  return { fetchPage, calls };
}

describe('walkDistinctTargets', () => {
  it('should collect each target once, in index order, skipping past a full page', async () => {
    // A has more proposals than a page holds: the next page starts after A, not inside it.
    const { fetchPage, calls } = fakeIndex([A, A, A, B, B, C, D], 2);
    await expect(walkDistinctTargets(fetchPage, { pageSize: 2 })).resolves.toEqual({ ids: [A, B, C, D], capped: false });
    expect(calls).toEqual([undefined, A, B, D]);
  });

  it('should stop at the end without a cap when the last page is full', async () => {
    const { fetchPage } = fakeIndex([A, B], 2);
    await expect(walkDistinctTargets(fetchPage, { pageSize: 2 })).resolves.toEqual({ ids: [A, B], capped: false });
  });

  it('should report a cap at max targets or max pages', async () => {
    const docs = [A, B, C, D];
    await expect(walkDistinctTargets(fakeIndex(docs, 2).fetchPage, { pageSize: 2, max: 3 })).resolves.toEqual({
      ids: [A, B, C],
      capped: true,
    });
    await expect(walkDistinctTargets(fakeIndex(docs, 1).fetchPage, { pageSize: 1, maxPages: 2 })).resolves.toEqual({
      ids: [A, B],
      capped: true,
    });
  });

  it('should ignore unreadable targets, paging on from the last readable one', async () => {
    await expect(walkDistinctTargets(async () => ['', A], { pageSize: 5 })).resolves.toEqual({ ids: [A], capped: false });
    const pages: Record<string, string[]> = { start: [A, ''], [A]: [B] };
    await expect(walkDistinctTargets(async (after) => pages[after ?? 'start'], { pageSize: 2 })).resolves.toEqual({
      ids: [A, B],
      capped: false,
    });
  });

  it('should throw rather than loop when a page does not move on', async () => {
    await expect(walkDistinctTargets(async () => [A, B], { pageSize: 2 })).rejects.toThrow(/did not move on/);
  });
});

describe('mergeDirectory', () => {
  it('should union every source, each id once with all of its sources', () => {
    expect(mergeDirectory({ contested: [A], proposed: [A, B], seated: [C] }, [B, D], () => false)).toEqual([
      { id: A, sources: ['contested', 'proposed'] },
      { id: B, sources: ['proposed', 'added'] },
      { id: C, sources: ['seated'] },
      { id: D, sources: ['added'] },
    ]);
  });

  it('should leave out a hidden contract unless the user added it', () => {
    const hidden = (id: string) => id === A || id === B;
    expect(mergeDirectory({ contested: [], proposed: [A, B, C], seated: [] }, [B], hidden)).toEqual([
      { id: B, sources: ['proposed', 'added'] },
      { id: C, sources: ['proposed'] },
    ]);
  });

  it('should need no known contract to list one', () => {
    expect(knownContractById(D)).toBeUndefined();
    expect(mergeDirectory({ contested: [], proposed: [D], seated: [] }, [])).toEqual([{ id: D, sources: ['proposed'] }]);
  });
});

describe('directoryGroup', () => {
  it('should split live contests, proposals waiting for an applicant, filled seats and the rest', () => {
    const groups: Record<ElectionPhase, string> = {
      'join-window': 'open',
      voting: 'open',
      closing: 'open',
      notice: 'waiting',
      'no-election': 'waiting',
      proposals: 'waiting',
      seated: 'decided',
      decided: 'decided',
      'not-elected': 'other',
      unknown: 'other',
    };
    for (const [phase, group] of Object.entries(groups)) expect(directoryGroup(phase as ElectionPhase)).toBe(group);
    expect(directoryGroup(undefined)).toBe('other');
  });
});

describe('labels', () => {
  it('should describe a contract by its description, else its keywords', () => {
    expect(contractAbout({ description: '  A   social\napp ', keywords: ['x'] })).toBe('A social app');
    expect(contractAbout({ description: 'x'.repeat(300) })).toHaveLength(140);
    expect(contractAbout({ description: 'x'.repeat(300) })?.endsWith('…')).toBe(true);
    expect(contractAbout({ description: null, keywords: ['social', ' ', 'posts'] })).toBe('Keywords: social, posts');
    expect(contractAbout({ description: null, keywords: [] })).toBeUndefined();
    expect(contractAbout(undefined)).toBeUndefined();
    // Owner-written text: no bidi overrides or zero-width characters, and no split emoji at the cut.
    expect(contractAbout({ description: 'safe\u202Etxet\u200B' })).toBe('safe txet');
    const emoji = contractAbout({ description: '😀'.repeat(200) });
    expect([...(emoji ?? '')]).toHaveLength(140);
    expect(emoji?.endsWith('😀…')).toBe(true);
  });

  it("should prefer the site's note, else say what the contract is and moderates", () => {
    expect(directoryNote({ note: 'Posts on Yappr.' }, 'ignored', ['post'])).toEqual(['Posts on Yappr.']);
    expect(directoryNote(undefined, 'A social app', ['post', 'reply'])).toEqual(['A social app', 'Moderates post, reply']);
    expect(directoryNote({}, undefined, ['note'])).toEqual(['Moderates note']);
    expect(directoryNote(undefined, undefined, [])).toEqual([]);
  });

  it('should name the current Yappr sites and the rehearsal set as staging-old', () => {
    expect(knownContractById('4nYYMMs94m4asfQ2PdJ69uqugpfJ7PaQNjhJyHXSeLfb')?.name).toBe('Yappr staging — posts');
    expect(knownContractById('5Kucw9g9TsiSRXbns2mPumXKVkYW7jwVrTdjFuFhMEwU')?.name).toBe('Yappr beta — posts');
    for (const id of [
      'AbDUiaXbJML5FQGSpt5oEdx88tXK8FPRXbAt1jwK3Us9',
      '9Z5W23rzbMdwPBEn9e5pKKz6rmRVAkoCYDTWaqzLpWqS',
      'HAEBfyZP9ECiX8crakwRSdjvVDkeJKPbG8Zs4YaRQrRa',
    ]) {
      expect(knownContractById(id)?.name).toMatch(/^Yappr staging-old \(rehearsal\)/);
    }
    expect(hiddenFromDirectory('2iaUXM8bZb6paYW1mRWCEUMe8EU1tp4Tbg456PXPN3qt')).toBe(true);
  });

  it('should list each known contract once, by a 32-byte id', () => {
    const ids = Object.values(KNOWN_CONTRACTS).flatMap((list) => list.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(base58Decode(id)).toHaveLength(32);
  });
});

// ---- discovery against a fake SDK --------------------------------------------

type Query = { documentTypeName: string; where?: unknown[][]; orderBy: unknown[][]; limit: number };

/** An SDK whose charters documents are `docs` (targets per type) and whose contested sweep returns `contested`. */
function fakeSdk(docs: Record<string, string[]>, contested: string[] = [], fail?: string) {
  const query = vi.fn(async (q: Query) => {
    if (q.documentTypeName === fail) throw new Error('node down');
    const all = [...(docs[q.documentTypeName] ?? [])].sort();
    const after = q.where?.[0]?.[2] as string | undefined;
    const page = all.filter((t) => after === undefined || t > after).slice(0, q.limit);
    return new Map(page.map((t, i) => [`${q.documentTypeName}-${t}-${i}`, { toJSON: () => ({ targetContractId: t }) }]));
  });
  const contestedResources = vi.fn(async () => contested);
  const sdk = { version: () => 14, documents: { query }, group: { contestedResources } } as unknown as EvoSDK;
  return { sdk, query, contestedResources };
}

describe('collectDirectoryIds', () => {
  it('should find targets from proposals, contests and seats on chain', async () => {
    const { sdk, query } = fakeSdk({ submittedCharter: [A, A, B], electedCharter: [C] }, [D]);
    const ids = await collectDirectoryIds(sdk);
    expect(ids).toEqual({ proposed: [A, B], contested: [D], seated: [C], failures: [], caps: [] });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        documentTypeName: 'submittedCharter',
        orderBy: [
          ['targetContractId', 'asc'],
          ['$createdAt', 'asc'],
        ],
      }),
    );
    expect(query.mock.calls.every(([q]) => q.where === undefined)).toBe(true);
  });

  it('should keep the other sources when one fails, and say which failed', async () => {
    const { sdk } = fakeSdk({ submittedCharter: [A], electedCharter: [C] }, [], 'electedCharter');
    const ids = await collectDirectoryIds(sdk);
    expect(ids.proposed).toEqual([A]);
    expect(ids.seated).toEqual([]);
    expect(ids.failures).toEqual([{ source: 'contracts with a seated moderator team', message: 'node down' }]);
  });

  it('should page on with a range past the last target and report a cap', async () => {
    const many = Array.from({ length: MAX_DISCOVERED_TARGETS + 1 }, (_, i) => base58Encode(new Uint8Array(32).fill(0).map((_, j) => (j < 2 ? (i >> (8 * j)) & 0xff : 7))));
    const { sdk, query } = fakeSdk({ submittedCharter: many });
    const ids = await collectDirectoryIds(sdk);
    expect(ids.proposed).toHaveLength(MAX_DISCOVERED_TARGETS);
    expect(ids.caps).toEqual([{ source: 'contracts with moderator proposals', limit: MAX_DISCOVERED_TARGETS }]);
    const ranges = query.mock.calls.filter(([q]) => q.documentTypeName === 'submittedCharter' && q.where);
    expect(ranges[0][0].where).toEqual([['targetContractId', '>', expect.any(String)]]);
  });
});

describe('discoverDirectory', () => {
  it('should read again after forgetDirectory', async () => {
    const fake = fakeSdk({ submittedCharter: [A] });
    forgetDirectory();
    await discoverDirectory(fake.sdk, 'mainnet', 1_000);
    forgetDirectory();
    await discoverDirectory(fake.sdk, 'mainnet', 2_000);
    expect(fake.contestedResources).toHaveBeenCalledTimes(2);
    forgetDirectory();
  });

  it('should reuse a clean result for a few minutes and retry one with failures', async () => {
    const clean = fakeSdk({ submittedCharter: [A] });
    await discoverDirectory(clean.sdk, 'mainnet', 1_000);
    await discoverDirectory(clean.sdk, 'mainnet', 2_000);
    expect(clean.contestedResources).toHaveBeenCalledTimes(1);
    await discoverDirectory(clean.sdk, 'mainnet', 1_000 + 6 * 60_000);
    expect(clean.contestedResources).toHaveBeenCalledTimes(2);

    const failing = fakeSdk({}, [], 'submittedCharter');
    const first = await discoverDirectory(failing.sdk, 'testnet', 1_000);
    expect(first.failures).toHaveLength(1);
    await discoverDirectory(failing.sdk, 'testnet', 2_000);
    expect(failing.contestedResources).toHaveBeenCalledTimes(2);
  });
});
