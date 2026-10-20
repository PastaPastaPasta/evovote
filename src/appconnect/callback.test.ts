// Partly ported from Yappr's lib/app-connect/callback-channel.test.ts (no mobile-app hand-back).
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACK_WAIT_MS,
  APP_CONNECT_CHANNEL,
  clearWalletReturn,
  handleWalletReturn,
  isConnectCallbackAck,
  isConnectCallbackMessage,
  parseWalletReturn,
  walletReturnState,
  withoutWalletReturn,
} from './callback';

const HASH = 'ab'.repeat(20);

describe('parseWalletReturn', () => {
  it('reads the request hash and the wallet status', () => {
    expect(parseWalletReturn(`?ac_r=${HASH}&ac=ok`)).toEqual({ requestHash: HASH, status: 'ok' });
    expect(parseWalletReturn(`?network=testnet&ac_r=${HASH.toUpperCase()}`)).toEqual({ requestHash: HASH, status: null });
  });

  it('ignores anything that is not a request hash, and odd statuses', () => {
    expect(parseWalletReturn('?ac_r=abc')).toBeNull();
    expect(parseWalletReturn('')).toBeNull();
    expect(parseWalletReturn(`?r=${HASH}`)).toBeNull();
    expect(parseWalletReturn(`?ac_r=${HASH}&ac=<script>`)).toEqual({ requestHash: HASH, status: null });
  });
});

describe('withoutWalletReturn', () => {
  it('drops only the return-link parameters and opens the given route', () => {
    expect(withoutWalletReturn(`https://x.io/evovote/?network=testnet&ac_r=${HASH}&ac=ok`, '#/me')).toBe(
      'https://x.io/evovote/?network=testnet#/me',
    );
    expect(withoutWalletReturn(`https://x.io/evovote/?ac_r=${HASH}`, '#/me')).toBe('https://x.io/evovote/#/me');
  });
});

describe('channel messages', () => {
  it('accept only well-formed messages for the right request', () => {
    expect(isConnectCallbackMessage({ type: 'app-connect-callback', requestHash: HASH, status: 'ok' })).toBe(true);
    expect(isConnectCallbackMessage({ type: 'app-connect-callback', requestHash: HASH, status: null })).toBe(true);
    expect(isConnectCallbackMessage({ type: 'app-connect-callback', requestHash: 'x', status: null })).toBe(false);
    expect(isConnectCallbackMessage({ type: 'app-connect-callback', requestHash: HASH, status: 'NOT OK' })).toBe(false);
    expect(isConnectCallbackMessage('app-connect-callback')).toBe(false);
    expect(isConnectCallbackAck({ type: 'app-connect-callback-ack', requestHash: HASH }, HASH)).toBe(true);
    expect(isConnectCallbackAck({ type: 'app-connect-callback-ack', requestHash: 'cd'.repeat(20) }, HASH)).toBe(false);
  });
});

describe('handleWalletReturn', () => {
  const opened: BroadcastChannel[] = [];
  afterEach(() => {
    opened.splice(0).forEach((c) => c.close());
    clearWalletReturn();
  });

  function fakeWindow(href: string): { win: Window; href: () => string } {
    let current = href;
    const win = {
      location: {
        get href() {
          return current;
        },
        get search() {
          return new URL(current).search;
        },
      },
      history: {
        replaceState: (_: unknown, __: string, url: string) => {
          current = url;
        },
      },
    } as unknown as Window;
    return { win, href: () => current };
  }

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('does nothing without a return link', () => {
    const { win, href } = fakeWindow('https://x.io/evovote/#/p/abc');
    handleWalletReturn(win);
    expect(href()).toBe('https://x.io/evovote/#/p/abc');
  });

  it('opens #/me and hands the request to the tab that answers', async () => {
    const qrTab = new BroadcastChannel(APP_CONNECT_CHANNEL);
    opened.push(qrTab);
    const received: unknown[] = [];
    qrTab.onmessage = (event: MessageEvent) => {
      received.push(event.data);
      qrTab.postMessage({ type: 'app-connect-callback-ack', requestHash: HASH });
    };
    const { win, href } = fakeWindow(`https://x.io/evovote/?ac_r=${HASH}&ac=ok`);
    handleWalletReturn(win);
    expect(href()).toBe('https://x.io/evovote/#/me');
    expect(walletReturnState()).toEqual({ phase: 'checking', requestHash: HASH });
    await pause(300);
    expect(received).toEqual([{ type: 'app-connect-callback', requestHash: HASH, status: 'ok' }]);
    expect(walletReturnState()).toEqual({ phase: 'other-tab', requestHash: HASH });
  });

  it('continues here when no tab answers within 1.5 s', async () => {
    const { win } = fakeWindow(`https://x.io/evovote/?ac_r=${HASH}&ac=ok`);
    handleWalletReturn(win);
    await pause(ACK_WAIT_MS + 200);
    expect(walletReturnState()).toEqual({ phase: 'here', requestHash: HASH });
  });

  it('shows what the wallet reported, and passes it on to the QR tab', async () => {
    const qrTab = new BroadcastChannel(APP_CONNECT_CHANNEL);
    opened.push(qrTab);
    const received: unknown[] = [];
    qrTab.onmessage = (event: MessageEvent) => received.push(event.data);
    const { win } = fakeWindow(`https://x.io/evovote/?ac_r=${HASH}&ac=declined`);
    handleWalletReturn(win);
    expect(walletReturnState()).toEqual({ phase: 'status', requestHash: HASH, status: 'declined' });
    await pause(100);
    expect(received).toEqual([{ type: 'app-connect-callback', requestHash: HASH, status: 'declined' }]);
  });
});
