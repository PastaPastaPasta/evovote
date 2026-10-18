/**
 * Which Dash network this page talks to.
 *
 * Precedence: `?network=` in the URL, then the stored choice, then testnet.
 * v2 targets testnet (protocol 14); mainnet stays selectable but shows a
 * banner until mainnet runs PV14.
 */
export type Network = 'mainnet' | 'testnet';

export const DEFAULT_NETWORK: Network = 'testnet';
const NETWORK_KEY = 'evovote.network';

function parseNetwork(value: string | null | undefined): Network | undefined {
  return value === 'mainnet' || value === 'testnet' ? value : undefined;
}

/** Pure resolution, exported for tests. */
export function resolveNetwork(search: string, stored: string | null): Network {
  const fromUrl = parseNetwork(new URLSearchParams(search).get('network'));
  return fromUrl ?? parseNetwork(stored) ?? DEFAULT_NETWORK;
}

function readStored(): string | null {
  try {
    return localStorage.getItem(NETWORK_KEY);
  } catch {
    return null;
  }
}

/** The network for this page load. Constant until switchNetwork() reloads. */
export function currentNetwork(): Network {
  return resolveNetwork(location.search, readStored());
}

/**
 * Persist the choice and reload. A full reload keeps exactly one WASM SDK
 * instance alive per page. An explicit `?network=` is rewritten too, or it
 * would win over the new choice on reload.
 */
export function switchNetwork(network: Network): void {
  let stored = false;
  try {
    localStorage.setItem(NETWORK_KEY, network);
    stored = true;
  } catch {
    // Storage disabled: the URL parameter below carries the choice instead.
  }
  const url = new URL(location.href);
  if (url.searchParams.has('network') || !stored) {
    // Changing the query string is a full navigation, so it reloads too.
    url.searchParams.set('network', network);
    location.assign(url.toString());
  } else {
    location.reload();
  }
}
