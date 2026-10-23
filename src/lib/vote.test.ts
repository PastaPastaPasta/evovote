import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadReceipts, recordReceipt } from './vote';

describe('vote receipts', () => {
  const proTxHash = 'a'.repeat(64);

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('persists successive receipts separately for each network', () => {
    recordReceipt('testnet', 'a1pha', proTxHash, { type: 'abstain' });
    recordReceipt('testnet', 'a1pha', proTxHash, { type: 'lock' });
    expect(loadReceipts('testnet').a1pha[proTxHash]).toEqual([
      { choice: { type: 'abstain' }, at: expect.any(Number) },
      { choice: { type: 'lock' }, at: expect.any(Number) },
    ]);
    expect(loadReceipts('mainnet')).toEqual({});
  });

  it.each(['QuotaExceededError', 'SecurityError'])(
    'does not fail an already broadcast vote when saving its receipt throws %s',
    (name) => {
      vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('Storage unavailable', name);
      });
      expect(() =>
        recordReceipt('testnet', 'a1pha', proTxHash, { type: 'abstain' }),
      ).not.toThrow();
    },
  );
});
