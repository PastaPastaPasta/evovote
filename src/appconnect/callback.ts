import { useSyncExternalStore } from 'react';
import { CALLBACK_REQUEST_PARAM } from './request';

/**
 * The wallet's return link. EvoVote routes by hash on GitHub Pages, so the
 * wallet comes back to the site root as `?ac_r=<request hash>&ac=<status>`
 * (possibly in a new tab). `handleWalletReturn` runs in main.tsx before the
 * app renders: it strips the query, opens `#/me`, and tells the tab showing
 * the QR code over a BroadcastChannel; that tab polls at once. When no tab
 * answers within 1.5 s, sign-in continues here, resuming the stored request.
 * Nothing in the link is trusted: the poll and the on-chain checks decide.
 * (From Yappr's lib/app-connect/callback-channel.ts and app/connect/page.tsx,
 * without the mobile-app hand-back.)
 */
export const APP_CONNECT_CHANNEL = 'evovote-app-connect';
const STATUS_PARAM = 'ac';
/** How long to wait for the tab showing the QR code to answer before continuing here. */
export const ACK_WAIT_MS = 1_500;

export interface ConnectCallbackMessage {
  type: 'app-connect-callback';
  requestHash: string;
  status: string | null;
}

export interface ConnectCallbackAck {
  type: 'app-connect-callback-ack';
  requestHash: string;
}

const REQUEST_HASH = /^[0-9a-f]{40}$/;

export function isConnectCallbackMessage(value: unknown): value is ConnectCallbackMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'app-connect-callback' &&
    typeof message.requestHash === 'string' &&
    REQUEST_HASH.test(message.requestHash) &&
    (message.status === null || (typeof message.status === 'string' && /^[a-z]{1,16}$/.test(message.status)))
  );
}

export function isConnectCallbackAck(value: unknown, requestHash: string): value is ConnectCallbackAck {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.type === 'app-connect-callback-ack' && message.requestHash === requestHash;
}

export interface WalletReturn {
  requestHash: string;
  /** `ok | declined | stale | unsupported | invalid | failed`, or null when absent or malformed. */
  status: string | null;
}

/** The return link's request hash and status, or null when the URL is not one. */
export function parseWalletReturn(search: string): WalletReturn | null {
  const params = new URLSearchParams(search);
  const requestHash = params.get(CALLBACK_REQUEST_PARAM)?.toLowerCase() ?? '';
  if (!REQUEST_HASH.test(requestHash)) return null;
  const status = params.get(STATUS_PARAM);
  return { requestHash, status: status && /^[a-z]{1,16}$/.test(status) ? status : null };
}

/** `href` without the return-link parameters (others, like `?network=`, stay), opened at `hash`. */
export function withoutWalletReturn(href: string, hash: string): string {
  const url = new URL(href);
  url.searchParams.delete(CALLBACK_REQUEST_PARAM);
  url.searchParams.delete(STATUS_PARAM);
  url.hash = hash;
  return url.toString();
}

/**
 * What the return link meant for this tab:
 * - `checking`: asking the tab with the QR code (up to 1.5 s);
 * - `other-tab`: that tab took it, this one can be closed;
 * - `here`: no tab answered, so sign-in continues in this tab;
 * - `status`: the wallet reported something other than `ok`.
 */
export type WalletReturnState =
  | { phase: 'checking'; requestHash: string }
  | { phase: 'other-tab'; requestHash: string }
  | { phase: 'here'; requestHash: string }
  | { phase: 'status'; requestHash: string; status: string };

let returnState: WalletReturnState | null = null;
const listeners = new Set<() => void>();

function setReturnState(next: WalletReturnState | null): void {
  returnState = next;
  for (const listener of listeners) listener();
}

/** What the return link meant for this tab (null when this load was not one, or after it was cleared). */
export function walletReturnState(): WalletReturnState | null {
  return returnState;
}

export function useWalletReturn(): WalletReturnState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => returnState,
  );
}

/** Forget the return link's notice (dismissed, or a new sign-in started). */
export function clearWalletReturn(): void {
  if (returnState) setReturnState(null);
}

/**
 * Handle a wallet return link, if this page load is one. Call once, before
 * the first render: it rewrites the URL to `#/me` so the router opens the
 * sign-in page.
 */
export function handleWalletReturn(win: Window = window): void {
  const ret = parseWalletReturn(win.location.search);
  if (!ret) return;
  win.history.replaceState(null, '', withoutWalletReturn(win.location.href, '#/me'));
  const message: ConnectCallbackMessage = { type: 'app-connect-callback', requestHash: ret.requestHash, status: ret.status };
  const failed = ret.status !== null && ret.status !== 'ok';
  if (typeof BroadcastChannel === 'undefined') {
    setReturnState(failed ? { phase: 'status', requestHash: ret.requestHash, status: ret.status as string } : { phase: 'here', requestHash: ret.requestHash });
    return;
  }
  const channel = new BroadcastChannel(APP_CONNECT_CHANNEL);
  // A decline is shown here, and passed on so the tab with the QR code can say so too.
  channel.postMessage(message);
  if (failed) {
    setReturnState({ phase: 'status', requestHash: ret.requestHash, status: ret.status as string });
    channel.close();
    return;
  }
  setReturnState({ phase: 'checking', requestHash: ret.requestHash });
  let answered = false;
  channel.onmessage = (event: MessageEvent) => {
    if (!isConnectCallbackAck(event.data, ret.requestHash)) return;
    answered = true;
    setReturnState({ phase: 'other-tab', requestHash: ret.requestHash });
    channel.close();
  };
  setTimeout(() => {
    if (answered) return;
    channel.close();
    setReturnState({ phase: 'here', requestHash: ret.requestHash });
  }, ACK_WAIT_MS);
}
