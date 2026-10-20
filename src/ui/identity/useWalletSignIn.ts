import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_CONNECT_CHANNEL, isConnectCallbackMessage } from '../../appconnect/callback';
import { AppConnectLogin, type AppConnectLoginState, type VerifiedCandidate } from '../../appconnect/loginFlow';
import type { AppConnectGrant } from '../../appconnect/protocol';
import { pendingRequestStore } from '../../appconnect/pendingRequest';
import { appConnectCallbackUrl } from '../../appconnect/request';
import { walletSessions } from '../../appconnect/runtime';
import type { Network } from '../../sdk/network';

function createLogin(network: Network): AppConnectLogin | null {
  const ring = walletSessions(network);
  if (!ring) return null;
  const warn = (message: string, error: unknown) => console.warn(message, error);
  return new AppConnectLogin({
    config: ring.config,
    network,
    port: ring.port,
    connectionId: () => ring.connectionId(),
    records: pendingRequestStore(() => ring.keyStore(), network, warn),
    callbackUrl: (hash) => appConnectCallbackUrl(window.location.href, hash),
    onError: warn,
  });
}

export interface WalletSignInActions {
  /** The confirmed identity's grant (its keys are the caller's to wipe), or null. */
  accept(identityId: string): AppConnectGrant | null;
  /** "That's not me": forget every answer and show a new code. */
  reject(): void;
  /** A fresh code. */
  restart(): void;
  /** After a timeout: poll the same code again while it is fresh. */
  checkAgain(): void;
  /** Retry the network check (offline, storage). */
  retry(): void;
}

/**
 * Runs a Dash Wallet sign-in while mounted and `enabled`: starts (or resumes)
 * a request, polls at once when the window regains focus or the wallet's
 * return link opens in another tab, and wipes everything on unmount.
 * `identityHint` makes it a renewal that only that identity may answer.
 * (From Yappr's hooks/use-app-connect-login.ts.)
 *
 * `walletStatus` is what a return link opened in another tab reported, when
 * it was not `ok` (for example `declined`). `onCandidates` hears every set of
 * verified answers as it arrives (a renewal accepts its own at once).
 */
export function useWalletSignIn(
  network: Network,
  {
    enabled = true,
    identityHint,
    onCandidates,
  }: { enabled?: boolean; identityHint?: string; onCandidates?: (candidates: VerifiedCandidate[]) => void } = {},
): { state: AppConnectLoginState; walletStatus: string | null; actions: WalletSignInActions } {
  // One instance per mount: a disposed instance never restarts, so React's
  // dev double-mount and a changed hint each get a fresh one.
  const loginRef = useRef<AppConnectLogin | null>(null);
  const candidatesRef = useRef(onCandidates);
  useEffect(() => {
    candidatesRef.current = onCandidates;
  });
  const [state, setState] = useState<AppConnectLoginState>(() =>
    walletSessions(network) ? { phase: 'checking' } : { phase: 'unavailable', reason: 'not-configured' },
  );
  const [walletStatus, setWalletStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const instance = createLogin(network);
    if (!instance) return;
    loginRef.current = instance;
    const unsubscribe = instance.subscribe((next) => {
      setState(next);
      if (next.phase !== 'waiting') setWalletStatus(null);
      if (next.phase === 'confirm') candidatesRef.current?.(next.candidates);
    });
    instance.start({ identityHint }).catch((error: unknown) => console.error('Wallet sign-in failed to start', error));

    const onFocus = () => instance.pollNow();
    window.addEventListener('focus', onFocus);
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(APP_CONNECT_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        if (!isConnectCallbackMessage(event.data) || event.data.requestHash !== instance.requestHashHex()) return;
        channel?.postMessage({ type: 'app-connect-callback-ack', requestHash: event.data.requestHash });
        if (event.data.status && event.data.status !== 'ok') setWalletStatus(event.data.status);
        instance.pollNow();
      };
    }
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      channel?.close();
      instance.dispose();
      if (loginRef.current === instance) loginRef.current = null;
    };
  }, [network, enabled, identityHint]);

  const actions = useMemo<WalletSignInActions>(() => {
    const report = (error: unknown) => console.error('Wallet sign-in', error);
    return {
      accept: (identityId) => loginRef.current?.accept(identityId) ?? null,
      reject: () => void loginRef.current?.reject().catch(report),
      restart: () => void loginRef.current?.start({ identityHint, fresh: true }).catch(report),
      checkAgain: () => void loginRef.current?.checkAgain().catch(report),
      retry: () => void loginRef.current?.start({ identityHint }).catch(report),
    };
  }, [identityHint]);

  return { state, walletStatus, actions };
}
