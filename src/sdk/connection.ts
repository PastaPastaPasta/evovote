import type { EvoSDK } from '@dashevo/evo-sdk';
import type { Network } from './network';

export type SdkModule = typeof import('@dashevo/evo-sdk');

/** The connected SDK plus the module (for wasm classes like VotePoll). */
export interface SdkHandle {
  sdk: EvoSDK;
  mod: SdkModule;
  network: Network;
}

let handle: Promise<SdkHandle> | null = null;

/**
 * Lazily import the SDK (a large chunk with inlined WASM) and connect once.
 * Every data call in the app funnels through this single connection.
 */
export function loadSdk(network: Network): Promise<SdkHandle> {
  if (!handle) {
    handle = (async () => {
      const mod = await import('@dashevo/evo-sdk');
      const sdk =
        network === 'mainnet'
          ? mod.EvoSDK.mainnetTrusted()
          : mod.EvoSDK.testnetTrusted();
      await sdk.connect();
      return { sdk, mod, network };
    })();
    handle.catch(() => {
      // Allow a retry after a failed connect instead of caching the rejection.
      handle = null;
    });
  }
  return handle;
}
