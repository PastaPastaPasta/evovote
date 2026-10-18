import { describe, expect, it } from 'vitest';
import { base58Encode } from '../model/bytes';
import { loadRecentContracts, rememberContract } from './recentContracts';

const id = (n: number) => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + n));

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe('recent contracts', () => {
  it('should keep a separate newest-first list per network', () => {
    const store = memoryStore();
    rememberContract('testnet', id(1), store);
    rememberContract('testnet', id(2), store);
    rememberContract('mainnet', id(3), store);
    rememberContract('testnet', id(1), store);
    expect(loadRecentContracts('testnet', store)).toEqual([id(1), id(2)]);
    expect(loadRecentContracts('mainnet', store)).toEqual([id(3)]);
  });

  it('should keep at most 8', () => {
    const store = memoryStore();
    for (let n = 1; n <= 12; n++) rememberContract('testnet', id(n), store);
    const list = loadRecentContracts('testnet', store);
    expect(list).toHaveLength(8);
    expect(list[0]).toBe(id(12));
  });

  it('should ignore corrupt or hostile stored data', () => {
    expect(loadRecentContracts('testnet', memoryStore({ 'evovote.recentContracts.testnet': 'not json' }))).toEqual([]);
    expect(
      loadRecentContracts('testnet', memoryStore({ 'evovote.recentContracts.testnet': JSON.stringify([id(1), 5, 'alice', '<script>']) })),
    ).toEqual([id(1)]);
    expect(loadRecentContracts('testnet', memoryStore({ 'evovote.recentContracts.testnet': '{"a":1}' }))).toEqual([]);
  });

  it('should survive storage that throws or is missing', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadRecentContracts('testnet', broken)).toEqual([]);
    expect(rememberContract('testnet', id(1), broken)).toEqual([id(1)]);
    expect(loadRecentContracts('testnet', undefined)).toEqual([]);
  });
});
