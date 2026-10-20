/**
 * Opt-in, read-only checks against testnet: `npm run test:live`.
 * They pin the Platform facts in docs/V2_NOTES.md that the code depends on.
 * Nothing here signs or broadcasts.
 */
import type { EvoSDK } from '@dashevo/evo-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectDirectoryIds } from '../charters/directory';
import { fetchElectionStatus, fetchProposals, fetchTeam, fetchWinnerProposals, leaderCanReceive } from '../charters/reads';
import { buildApplication, contestFundToJoin, estimateCreate, MODERATION_CONTEST_FUND } from '../charters/writes';
import { fetchActivePolls } from '../discovery/activePolls';
import { keyInfoFrom } from '../identity/keys';
import type { SdkHandle } from '../sdk/connection';
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

// An identity that owns a DPNS name on testnet (000.dash), with plain keys.
const DPNS_OWNER = '9idHpqmf8i9U6tfWiWMQCVF39vshNgYisT7DL6yK2pCF';

let sdk: EvoSDK;
let handle: SdkHandle;

beforeAll(async () => {
  const mod = await import('@dashevo/evo-sdk');
  sdk = mod.EvoSDK.testnetTrusted({ settings: { timeoutMs: 30_000 } });
  await sdk.connect();
  handle = { sdk, mod, network: 'testnet' };
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

  // ---- moderator elections and the identity session (WP2/WP3), read-only ----

  it('reads a non-elected contract as not-elected, with every read succeeding', async () => {
    const status = await fetchElectionStatus(sdk, DPNS_CONTRACT_ID, { force: true });
    expect(status.failures).toEqual([]);
    expect(status.contractFound).toBe(true);
    expect(status.moderation?.declaration.kind).toBe('none');
    expect(status.timing.phase).toBe('not-elected');
    await expect(fetchTeam(sdk, DPNS_CONTRACT_ID)).resolves.toBeUndefined();
    await expect(fetchProposals(sdk, DPNS_CONTRACT_ID)).resolves.toEqual({ proposals: [], capped: false });
  });

  it('builds the moderated-contract directory without read failures', async () => {
    const ids = await collectDirectoryIds(sdk, 'testnet');
    expect(ids.failures).toEqual([]);
  });

  it("reads seated winners' proposals in two batched `in` queries", async () => {
    // Two seated testnet elections (EvoVote QA, a Yappr staging contract).
    const targets = ['71PHn75xGEPbQ92i296HDHjFXLoLTWBEXzG3pJEQWStc', 'EFyPZPsEDLHtN1R38CgzeAGfWr23DrgthPpTgbCW8zAt'];
    const teams = await Promise.all(targets.map((t) => fetchTeam(sdk, t)));
    const wins = targets.flatMap((t, i) => {
      const team = teams[i];
      return team ? [{ targetContractId: t, winnerId: team.leaderId, decidedAtMs: Date.now() }] : [];
    });
    expect(wins).toHaveLength(2);
    const won = await fetchWinnerProposals(sdk, wins);
    targets.forEach((t, i) => expect(won.get(t)?.id).toBe(teams[i]?.submittedCharterId));
  });

  it('prices every charter write with Drive\'s estimator', async () => {
    for (const type of ['reason', 'submittedCharter', 'joinRequest', 'electedCharter'] as const) {
      const cost = await estimateCreate(handle, type);
      expect(cost.fees).toBeGreaterThan(0n);
      expect(cost.fees).toBeLessThan(1_000_000_000n); // under 0.01 DASH
    }
  });

  it('asks 0.5 DASH to join a moderator election', async () => {
    const application = buildApplication(handle.mod, {
      targetContractId: DPNS_CONTRACT_ID,
      leaderId: DPNS_OWNER,
      submittedCharterId: CHARTERS_CONTRACT_ID,
      members: [],
    });
    try {
      expect(await contestFundToJoin(handle, application)).toBe(MODERATION_CONTEST_FUND);
    } finally {
      application.free();
    }
  });

  it('finds an identity by its key hash and reads its keys', async () => {
    const identity = await sdk.identities.fetch(DPNS_OWNER);
    const keys = identity!.publicKeys.map(keyInfoFrom);
    expect(keys[0]).toMatchObject({ purpose: 'AUTHENTICATION', securityLevel: 'MASTER' });
    const found = await sdk.identities.byPublicKeyHash(keys[1].hash160);
    expect(found?.id.toBase58()).toBe(DPNS_OWNER);
    await expect(leaderCanReceive(sdk, DPNS_OWNER)).resolves.toBe(false);
  });
});
