/**
 * Opt-in, read-only checks against testnet: `npm run test:live`.
 * They pin the Platform facts in docs/V2_NOTES.md that the code depends on.
 * Nothing here signs or broadcasts.
 */
import type { EvoSDK } from '@dashevo/evo-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { fetchActivePolls } from '../discovery/activePolls';
import { sweepContestedResources } from '../discovery/archive';
import { fetchContestedIndex } from '../discovery/contracts';
import { fetchContest } from '../discovery/voteState';
import { CHARTERS_CONTRACT_ID, charterKind } from '../kinds/charter';
import { DPNS_CONTRACT_ID, dpnsKind } from '../kinds/dpns';
import type { PollKey } from '../model/pollKey';
import { encodePollKey } from '../model/pollKey';
import { readCurrentVotes } from '../voting/currentVotes';
import { voterKeyMatches } from '../voting/keyring';
import { voterIdentityId } from '../voting/keys';

// A testnet evonode and its ProRegTx voting key hash (insight, 2026-10-17).
const PRO_TX_HASH = 'f37de98bcd094e33307c6705204bccdf4d7ad10eb08999c1c9281847b5ef22b0';
const VOTING_HASH160 = 'c88818ac93c56d21cb72c3255e3de33d160674d3';

let sdk: EvoSDK;

beforeAll(async () => {
  const mod = await import('@dashevo/evo-sdk');
  sdk = mod.EvoSDK.testnetTrusted({ settings: { timeoutMs: 30_000 } });
  await sdk.connect();
});

describe('testnet (rc.4, read-only)', () => {
  it('runs protocol 14', async () => {
    const status = (await sdk.system.status()).toJSON() as {
      version: { protocol: { drive: { current: number } } };
    };
    expect(status.version.protocol.drive.current).toBe(14);
  });

  it('accepts bigint and number time bounds on votePollsByEndDate', async () => {
    const now = Date.now();
    await expect(
      sdk.voting.votePollsByEndDate({
        startTimeMs: BigInt(now),
        endTimeMs: now + 86_400_000,
        orderAscending: true,
        limit: 10,
      }),
    ).resolves.toBeInstanceOf(Array);
    const active = await fetchActivePolls(sdk);
    expect(active.failures).toEqual([]);
  });

  it('refuses offset on votePollsByEndDate (no offset fallback)', async () => {
    await expect(sdk.voting.votePollsByEndDate({ offset: 1, limit: 5 })).rejects.toMatchObject({
      message: expect.stringMatching(/offset/),
    });
  });

  it('reads a DPNS contest through the archive sweep and vote state', async () => {
    let first: PollKey | undefined;
    for await (const page of dpnsKind.archive!(sdk)) {
      expect(page.failure).toBeUndefined();
      first = page.keys[0];
      break;
    }
    expect(first).toBeDefined();
    const contest = await fetchContest(sdk, { key: first!, keyString: encodePollKey(first!) });
    expect(contest.resolution).toBe(0);
    expect(contest.tally.contenders.length).toBeGreaterThan(0);
  });

  it('reads the elected charter index as resolution 1 and sweeps it under group', async () => {
    const index = await fetchContestedIndex(sdk, CHARTERS_CONTRACT_ID, 'electedCharter', 'byTargetContract');
    expect(index?.resolution).toBe(1);
    for await (const page of charterKind.archive!(sdk)) {
      expect(page.failure).toBeUndefined();
    }
    const dpnsIndex = await fetchContestedIndex(sdk, DPNS_CONTRACT_ID, 'domain', 'parentNameAndLabel');
    expect(dpnsIndex?.resolution).toBe(0);
  });

  it('exposes the moderationCharters facade', () => {
    for (const fn of ['team', 'seatedCharter', 'submittedCharter', 'submittedCharters', 'joinRequests', 'buildJoinRequest']) {
      expect(typeof (sdk.moderationCharters as unknown as Record<string, unknown>)[fn]).toBe('function');
    }
  });

  it('derives an existing voter identity whose key 0 is the voting key hash', async () => {
    const voterId = await voterIdentityId(PRO_TX_HASH, VOTING_HASH160);
    const identity = await sdk.identities.fetch(voterId);
    expect(identity).toBeTruthy();
    const key0 = identity!.getPublicKeyById(0);
    expect(voterKeyMatches(key0?.toJSON() as { purpose?: unknown; data?: unknown }, VOTING_HASH160)).toBe(true);
  });

  it('reads identity votes keyed by ProTxHash', async () => {
    await expect(readCurrentVotes(sdk, PRO_TX_HASH)).resolves.toBeInstanceOf(Map);
  });

  it('sweeps DPNS contested resources as label strings', async () => {
    const pages = sweepContestedResources(
      sdk,
      {
        source: 'probe',
        contractId: DPNS_CONTRACT_ID,
        documentTypeName: 'domain',
        indexName: 'parentNameAndLabel',
        prefix: [{ type: 'text', value: 'dash' }],
        toKey: (r) => {
          expect(typeof r).toBe('string');
          return undefined;
        },
      },
      { pageSize: 5, maxPages: 1 },
    );
    for await (const page of pages) expect(page.failure).toBeUndefined();
  });
});
