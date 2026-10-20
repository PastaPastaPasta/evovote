import { parseStoredRequest, type RequestRecordStore, type StoredAppConnectRequest } from './loginFlow';
import type { AppConnectKeyRingStore } from './keyRing';

/**
 * The pending sign-in request, so a reload or the wallet's return link can
 * resume it (10 minutes at most). Its ephemeral key opens the wallet's
 * answer, so it is wrapped under the key ring's device key, never stored in
 * plain. (From Yappr's lib/app-connect/pending-request.ts; one slot, since
 * EvoVote has no separate renewal flow.)
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SECRET_NAME = 'pending-request:login';
const RECORD_LOCK = 'evovote-app-connect-pending-request';

/**
 * Record operations run one at a time, in call order, across every tab of
 * this site: a save wraps the key (async crypto) before it writes, and a
 * clear reads the slot before it deletes it, so without this an older
 * request could land last, or one tab could delete a request another tab
 * saved between its read and its delete. A Web Lock where the browser has
 * them, an in-tab queue otherwise.
 */
let recordWrites: Promise<unknown> = Promise.resolve();
function inOrder<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  const locked = async (): Promise<T> => (locks ? await locks.request(RECORD_LOCK, operation) : await operation());
  const run = recordWrites.then(locked, locked);
  recordWrites = run.catch(() => undefined);
  return run;
}

export function pendingRequestStore(
  keyStore: () => AppConnectKeyRingStore,
  network: string,
  onWarning?: (message: string, error: unknown) => void,
): RequestRecordStore {
  return {
    async load() {
      try {
        // Read and (for a stale request) delete under the same lock.
        return await inOrder(async () => {
          const bytes = await keyStore().loadSecret(network, SECRET_NAME);
          if (!bytes) return null;
          let record: StoredAppConnectRequest | null = null;
          try {
            record = parseStoredRequest(JSON.parse(decoder.decode(bytes)), Date.now());
          } catch {
            // Unreadable: treated like a stale request below.
          } finally {
            bytes.fill(0);
          }
          if (!record) await keyStore().deleteSecret(network, SECRET_NAME);
          return record;
        });
      } catch (error) {
        onWarning?.('Wallet sign-in: could not read the pending request', error);
        return null;
      }
    },
    async save(record) {
      const bytes = encoder.encode(JSON.stringify(record));
      try {
        await inOrder(() => keyStore().saveSecret(network, SECRET_NAME, bytes));
      } catch (error) {
        // Without storage the request only lives in this tab.
        onWarning?.('Wallet sign-in: could not keep the pending request', error);
      } finally {
        bytes.fill(0);
      }
    },
    async clear(record) {
      // Only if it is still ours: another tab may have stored a newer request in this slot.
      await inOrder(async () => {
        const bytes = await keyStore().loadSecret(network, SECRET_NAME);
        if (!bytes) return;
        let stored: unknown = null;
        try {
          stored = JSON.parse(decoder.decode(bytes));
        } catch {
          // Unreadable: not a request anyone can resume, so it may go.
        } finally {
          bytes.fill(0);
        }
        const storedKey = (stored as { ephemeralPrivateKey?: unknown } | null)?.ephemeralPrivateKey;
        if (stored === null || storedKey === record.ephemeralPrivateKey) {
          await keyStore().deleteSecret(network, SECRET_NAME);
        }
      });
    },
  };
}
