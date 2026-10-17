/**
 * Opt-in, read-only: the `#/c/<contractId>` assembly against testnet
 * (`npm run test:live`). The DPNS contract has a contested index, so the
 * browser must find it, sweep it with a small cap and read the vote states.
 * Nothing here signs or broadcasts.
 */
import type { EvoSDK } from '@dashevo/evo-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { browseContract } from '../discovery/contractBrowser';
import { DPNS_CONTRACT_ID } from '../kinds/dpns';
import { kindFor } from '../kinds/registry';

let sdk: EvoSDK;

beforeAll(async () => {
  const mod = await import('@dashevo/evo-sdk');
  sdk = mod.EvoSDK.testnetTrusted({ settings: { timeoutMs: 30_000 } });
  await sdk.connect();
});

describe('contract browser (testnet, read-only)', () => {
  it('assembles the DPNS contract: its contested index, a capped sweep and vote states', async () => {
    const view = await browseContract(sdk, DPNS_CONTRACT_ID, { maxContests: 5, tallyConcurrency: 3 });
    expect(view.load).toBe('ready');
    expect(view.documentTypes).toContain('domain');
    expect(view.failures).toEqual([]);

    expect(view.types).toHaveLength(1);
    const [type] = view.types;
    expect(type.index).toMatchObject({ documentTypeName: 'domain', indexName: 'parentNameAndLabel', resolution: 0 });
    expect(type.index.fieldMatches[0]).toMatchObject({ field: 'normalizedLabel' });
    expect(type.sweeping).toBe(false);

    // 1000+ names are contested on testnet, so the cap must show.
    expect(type.contests).toHaveLength(5);
    expect(view.caps).toEqual([{ source: 'domain · parentNameAndLabel', limit: 5 }]);
    for (const { summary, state } of type.contests) {
      expect(summary.key.indexValues[0]).toEqual({ type: 'text', value: 'dash' });
      expect(kindFor(summary.key).id).toBe('dpns');
      expect(typeof state).toBe('object');
    }
  });

  it('says plainly that a missing contract does not exist', async () => {
    const view = await browseContract(sdk, '11111111111111111111111111111111111111111111'.slice(0, 43));
    expect(['not-found', 'error']).toContain(view.load);
    expect(view.types).toEqual([]);
  });
});
