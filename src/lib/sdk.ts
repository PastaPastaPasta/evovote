import type { EvoSDK } from '@dashevo/evo-sdk';

export type Network = 'mainnet' | 'testnet';
export type SdkModule = typeof import('@dashevo/evo-sdk');

export interface SdkHandle {
  sdk: EvoSDK;
  mod: SdkModule;
}

const NETWORK_KEY = 'evovote.network';

export function storedNetwork(): Network {
  const url = new URL(location.href);
  try {
    const old = localStorage.getItem(NETWORK_KEY);
    localStorage.removeItem(NETWORK_KEY);
    if (!url.searchParams.has('network') && old === 'testnet') url.searchParams.set('network', 'testnet');
  } catch {}
  const value = url.searchParams.get('network');
  if (value && !['mainnet', 'testnet', 'main', 'test'].includes(value)) return 'mainnet';
  const network = value === 'testnet' || value === 'test' ? 'testnet' : 'mainnet';
  url.searchParams.set('network', network);
  if (url.href !== location.href) history.replaceState(history.state, '', url);
  return network;
}

/** WASM SDK errors are wasm-bindgen objects, not Error instances. */
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

let handle: Promise<SdkHandle> | null = null;

/**
 * Lazily import the SDK (a ~9 MB chunk with inlined WASM) and connect once.
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
      return { sdk, mod };
    })();
    handle.catch(() => {
      // Allow a retry after a failed connect instead of caching the rejection.
      handle = null;
    });
  }
  return handle;
}
