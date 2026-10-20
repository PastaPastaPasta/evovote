import type { DocumentWhereClause } from '@dashevo/wasm-sdk';
import { base58Decode } from '../model/bytes';
import { loadSdk } from '../sdk/connection';
import { freeQuietly } from '../sdk/free';
import type { Network } from '../sdk/network';
import { APP_CONNECT_RESPONSE_CONTRACT_ID, APP_CONNECT_RESPONSE_DOCUMENT_TYPE } from './config';
import { bytesFrom, toAppConnectIdentityKeys, type WasmIdentityKeyLike } from './keyMapping';
import type { AppConnectCandidate, AppConnectIdentityKey, AppConnectIdentityPort, AppConnectResponsePort } from './protocol';

/**
 * App Connect's chain reads over EvoVote's one SDK connection (`loadSdk`).
 * The facade methods verify proofs, and identity reads go to the network
 * directly (EvoVote keeps no identity cache): a key added moments ago is
 * exactly what the verifier checks. EvoVote binds no contract group, so
 * `groupInfo` has nothing to read.
 */

/** Block time and protocol version from the latest proved response. */
export interface AppConnectChainStatus {
  protocolVersion: number;
  blockTimeMs: number;
}

export interface AppConnectPlatformPort extends AppConnectIdentityPort, AppConnectResponsePort {
  chainStatus(): Promise<AppConnectChainStatus>;
}

/** Maps wasm keys and frees them. */
function mapKeys(keys: unknown[]): AppConnectIdentityKey[] {
  try {
    return toAppConnectIdentityKeys(keys as WasmIdentityKeyLike[]);
  } finally {
    keys.forEach(freeQuietly);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function compareIds(a: string, b: string): number {
  const left = base58Decode(a);
  const right = base58Decode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

/** A `loginKeyResponse` document as a candidate; null when malformed. */
export function candidateFromDocument(doc: {
  ownerId: { toBase58(): string };
  properties: Record<string, unknown>;
}): AppConnectCandidate | null {
  const walletEphemeralPubKey = bytesFrom(doc.properties.walletEphemeralPubKey, 'base64');
  const encryptedPayload = bytesFrom(doc.properties.encryptedPayload, 'base64');
  if (!walletEphemeralPubKey || !encryptedPayload) return null;
  return { ownerId: doc.ownerId.toBase58(), walletEphemeralPubKey, encryptedPayload };
}

export function appConnectPort(network: Network): AppConnectPlatformPort {
  const sdk = async () => (await loadSdk(network)).sdk;
  return {
    async getIdentityFresh(identityId) {
      const identity = await (await sdk()).identities.fetch(identityId);
      if (!identity) return null;
      try {
        return { id: identity.id.toBase58(), publicKeys: mapKeys(identity.publicKeys) };
      } finally {
        freeQuietly(identity);
      }
    },

    async remainingBudgets(identityId, keyIds) {
      const budgets = await (await sdk()).identities.keysRemainingBudgets(identityId, keyIds);
      const result = new Map<number, bigint | undefined>();
      for (const [keyId, remaining] of budgets) result.set(Number(keyId), remaining ?? undefined);
      return result;
    },

    async contractKeys(identityId, contractId, purpose) {
      const entries = await (await sdk()).identities.contractKeys({ identityIds: [identityId], contractId, purposes: [purpose] });
      try {
        const entry = entries.find((candidate) => candidate.identityId.toBase58() === identityId);
        return entry ? mapKeys(entry.keys) : [];
      } finally {
        entries.forEach(freeQuietly);
      }
    },

    async groupInfo() {
      return null;
    },

    async listCandidates(requestHash, hint, startAfter, limit) {
      // Entries are keyed (appEphemeralPubKeyHash, $ownerId) and pages
      // continue after the last owner, as in Yappr's port.
      const where: DocumentWhereClause[] = [['appEphemeralPubKeyHash', '==', base64(requestHash)]];
      if (hint) where.push(['$ownerId', '==', hint]);
      else if (startAfter) where.push(['$ownerId', '>', startAfter]);
      const response = await (await sdk()).documents.query({
        dataContractId: APP_CONNECT_RESPONSE_CONTRACT_ID,
        documentTypeName: APP_CONNECT_RESPONSE_DOCUMENT_TYPE,
        where,
        orderBy: [['$ownerId', 'asc']],
        limit,
      });
      const candidates: AppConnectCandidate[] = [];
      for (const document of response.values()) {
        if (!document) continue;
        try {
          const candidate = candidateFromDocument(document as unknown as Parameters<typeof candidateFromDocument>[0]);
          if (candidate) candidates.push(candidate);
        } catch {
          // A malformed entry is just not a candidate.
        } finally {
          freeQuietly(document);
        }
      }
      // The poller relies on owner order; Platform returns it, but a Map's order is the SDK's.
      return candidates.sort((a, b) => compareIds(a.ownerId, b.ownerId));
    },

    async chainStatus() {
      const response = await (await sdk()).protocol.versionUpgradeStateWithProof();
      try {
        const { metadata } = response;
        return { protocolVersion: metadata.protocolVersion, blockTimeMs: Number(metadata.timeMs) };
      } finally {
        freeQuietly(response);
      }
    },
  };
}
