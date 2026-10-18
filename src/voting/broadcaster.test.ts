import { describe, expect, it } from 'vitest';
import { runBroadcast, type BroadcastJob } from './broadcaster';

describe('runBroadcast', () => {
  it('should run one masternode sequentially and cap parallel masternodes', async () => {
    const log: string[] = [];
    let active = 0;
    let peak = 0;
    const perMnActive = new Map<string, number>();
    const job = (mnId: string, n: number, outcome: boolean | Error = true): BroadcastJob => ({
      id: `${mnId}-${n}`,
      mnId,
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        perMnActive.set(mnId, (perMnActive.get(mnId) ?? 0) + 1);
        expect(perMnActive.get(mnId)).toBe(1);
        await new Promise((r) => setTimeout(r, 3));
        log.push(`${mnId}-${n}`);
        perMnActive.set(mnId, perMnActive.get(mnId)! - 1);
        active--;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    });
    const jobs = [
      ...Array.from({ length: 10 }, (_, i) => job(`mn${i}`, 0)),
      job('mn0', 1, false),
      job('mn1', 1, Object.assign(new Error('x'), { code: 40304 })),
    ];
    const statuses: string[] = [];
    const results = await runBroadcast(jobs, (id, s) => statuses.push(`${id}:${s.step}`), 3);
    expect(peak).toBeLessThanOrEqual(3);
    expect(log.indexOf('mn0-0')).toBeLessThan(log.indexOf('mn0-1'));
    expect(results.get('mn0-0')).toEqual({ step: 'accepted' });
    expect(results.get('mn0-1')).toEqual({ step: 'unverified' });
    expect(results.get('mn1-1')).toMatchObject({ step: 'failed', error: { code: 40304 } });
    expect(statuses).toContain('mn5-0:queued');
    expect(statuses).toContain('mn5-0:sending');
  });
});
