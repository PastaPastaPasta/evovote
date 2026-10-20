import type { KeyRingBackend } from './keyRing';
import type { AppConnectPlatformPort } from './port';
import type { AppConnectGrant, AppConnectIdentityKey } from './protocol';

/** Test doubles shared by the session tests (never imported by app code). */

export function memoryBackend(): KeyRingBackend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => {
      data.set(key, structuredClone(value));
    },
    delete: async (key) => {
      data.delete(key);
    },
    deleteIf: async (key, predicate) => {
      if (!data.has(key) || !predicate(data.get(key))) return false;
      data.delete(key);
      return true;
    },
    updateIf: async (key, predicate, next) => {
      if (!data.has(key) || !predicate(data.get(key))) return false;
      data.set(key, structuredClone(next(data.get(key))));
      return true;
    },
    putIf: async (key, predicate, value) => {
      if (predicate(data.get(key))) data.set(key, structuredClone(value));
      return data.get(key);
    },
  };
}

/** A port whose identity keys and budgets the test sets. */
export function fakePort(): AppConnectPlatformPort & {
  keys: AppConnectIdentityKey[];
  budgets: Map<number, bigint | undefined>;
} {
  const port = {
    keys: [] as AppConnectIdentityKey[],
    budgets: new Map<number, bigint | undefined>(),
    getIdentityFresh: async (id: string) => ({ id, publicKeys: port.keys }),
    remainingBudgets: async () => port.budgets,
    contractKeys: async () => [],
    groupInfo: async () => null,
    listCandidates: async () => [],
    chainStatus: async () => ({ protocolVersion: 14, blockTimeMs: Date.now() }),
  };
  return port;
}

/** A verified grant of one HIGH key bound to `contractId`. */
export function commentGrant(
  identityId: string,
  contractId: string,
  options: { keyId?: number; privateKey?: Uint8Array; data?: Uint8Array; expiresAt?: number; totalBudget?: bigint } = {},
): AppConnectGrant {
  return {
    identityId,
    authKeys: [
      {
        role: 'singleContract',
        bindingIndex: 0,
        privateKey: options.privateKey?.slice() ?? new Uint8Array(32).fill(9),
        remainingBudget: options.totalBudget ?? 10_000_000_000n,
        key: {
          id: options.keyId ?? 7,
          type: 0,
          purpose: 0,
          securityLevel: 2,
          data: options.data ?? new Uint8Array(33).fill(2),
          bounds: { kind: 'singleContract', contractId },
          totalBudget: options.totalBudget ?? 10_000_000_000n,
          expiresAt: options.expiresAt ?? Date.now() + 90 * 24 * 60 * 60_000,
        },
      },
    ],
    encryptionKeys: [],
  };
}
