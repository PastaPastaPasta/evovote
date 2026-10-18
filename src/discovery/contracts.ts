import type { EvoSDK } from '@dashevo/evo-sdk';
import type { Resolution } from '../model/contest';

type DataContract = NonNullable<Awaited<ReturnType<EvoSDK['contracts']['fetch']>>>;

const contracts = new Map<string, Promise<DataContract | undefined>>();

/** A data contract, fetched once per page load (failed fetches are retried). */
export function fetchContract(sdk: EvoSDK, contractId: string): Promise<DataContract | undefined> {
  let hit = contracts.get(contractId);
  if (!hit) {
    hit = sdk.contracts.fetch(contractId).then((c) => c ?? undefined);
    contracts.set(contractId, hit);
    hit.catch(() => contracts.delete(contractId));
  }
  return hit;
}

/** A document type's contested unique index, as its contract declares it. */
export interface ContestedIndex {
  documentTypeName: string;
  indexName: string;
  /** Index properties in order, e.g. ["normalizedParentDomainName", "normalizedLabel"]. */
  properties: string[];
  resolution: Resolution;
  description?: string;
}

interface IndexJson {
  name?: unknown;
  properties?: unknown;
  contested?: { resolution?: unknown; description?: unknown };
}

/**
 * The contested indices in a contract's JSON (`documentSchemas[type].indices`
 * with a `contested` block). A contract may declare at most one per document
 * type. Pure; exported for tests and the WP5 contract browser.
 */
export function contestedIndices(contractJson: unknown): ContestedIndex[] {
  const schemas = (contractJson as { documentSchemas?: Record<string, unknown> })
    ?.documentSchemas;
  if (!schemas || typeof schemas !== 'object') return [];
  const out: ContestedIndex[] = [];
  for (const [documentTypeName, schema] of Object.entries(schemas)) {
    const indices = (schema as { indices?: unknown })?.indices;
    if (!Array.isArray(indices)) continue;
    for (const raw of indices as IndexJson[]) {
      if (!raw?.contested || typeof raw.name !== 'string') continue;
      const resolution = Number(raw.contested.resolution ?? 0);
      out.push({
        documentTypeName,
        indexName: raw.name,
        properties: Array.isArray(raw.properties)
          ? raw.properties.flatMap((p) =>
              p && typeof p === 'object' ? Object.keys(p as object).slice(0, 1) : [],
            )
          : [],
        resolution: resolution === 1 ? 1 : 0,
        description:
          typeof raw.contested.description === 'string'
            ? raw.contested.description
            : undefined,
      });
    }
  }
  return out;
}

/** The contested index of `docType` in `contractId`, or undefined. Throws when the read fails. */
export async function fetchContestedIndex(
  sdk: EvoSDK,
  contractId: string,
  documentTypeName: string,
  indexName: string,
): Promise<ContestedIndex | undefined> {
  const contract = await fetchContract(sdk, contractId);
  if (!contract) return undefined;
  return contestedIndices(contract.toJSON(sdk.version())).find(
    (ix) => ix.documentTypeName === documentTypeName && ix.indexName === indexName,
  );
}
