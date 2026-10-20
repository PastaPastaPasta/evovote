import type { Network } from '../sdk/network';
import { appConnectConfig } from './config';
import { appConnectPort } from './port';
import { WalletSessions } from './sessions';

/**
 * The page's one wallet key ring, for its network (EvoVote reloads to switch
 * networks). Null when wallet sign-in is not configured on this build.
 */
let instance: WalletSessions | null | undefined;

export function walletSessions(network: Network): WalletSessions | null {
  if (instance === undefined || (instance && instance.config.network !== network)) {
    const config = appConnectConfig(network);
    instance = config
      ? new WalletSessions({
          config,
          port: appConnectPort(network),
          onWarning: (message, error) => console.warn(message, error ?? ''),
        })
      : null;
  }
  return instance;
}

/** Tests: use `sessions` (or rebuild from the environment with undefined). */
export function setWalletSessions(sessions: WalletSessions | null | undefined): void {
  instance = sessions;
}
