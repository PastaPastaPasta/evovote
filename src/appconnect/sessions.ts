import { appConnectStanding, primaryKey, reconcileSessionWithChain, type AppConnectHealth, type RenewSoonReason } from './health';
import type { AppConnectConfig } from './config';
import {
  AppConnectKeyRingStore,
  exactGrant,
  indexedDbKeyRingBackend,
  isNewerGrant,
  isSameGrant,
  type KeyRingBackend,
  type SessionMatch,
} from './keyRing';
import type { AppConnectPlatformPort } from './port';
import {
  APP_CONNECT_SESSION_VERSION,
  buildAppConnectSession,
  classifyAppConnectError,
  type AppConnectGrant,
  type AppConnectSession,
  type AppConnectSigningFailure,
} from './protocol';
import { clearSensitiveBytes } from './protocol/legacy';

/**
 * This browser's wallet key ring: the keys Dash Wallet granted for the
 * signed-in identity, their health (allowance and expiry), and what happens
 * when the wallet revokes them. A trimmed port of Yappr's
 * lib/app-connect/session-manager.ts.
 *
 * Kept from Yappr: adopt, restore, sign-out, the hourly refresh from chain,
 * write-failure handling, and the cross-tab fencing (the store never lets an
 * older grant overwrite or delete a newer one another tab stored; a sign-out
 * overtakes an adoption still under way; a revoke first looks for a newer
 * grant another tab stored before signing out). Dropped: the contract-group
 * trust check (EvoVote binds no group), messaging encryption keys, token
 * signing and the mobile key-ring backend. Private keys never leave the ring
 * except as bytes handed straight to the SDK signer.
 */

/** Why writes stopped until the user signs in with the wallet again. */
export type RenewReason = 'expired' | 'allowance-spent' | 'insufficient-allowance';

export interface WalletStatus {
  /** The identity with a wallet key ring in this tab, or null. */
  identityId: string | null;
  health: AppConnectHealth | null;
  renewSoon: RenewSoonReason | null;
  /** Set when a write was refused for the allowance or expiry. */
  renewRequired: RenewReason | null;
  /** The wallet revoked this browser's keys; the ring was wiped. */
  signedOutByWallet: boolean;
}

const EMPTY_STATUS: WalletStatus = {
  identityId: null,
  health: null,
  renewSoon: null,
  renewRequired: null,
  signedOutByWallet: false,
};

const REFRESH_INTERVAL_MS = 60 * 60_000;
const FIRST_REFRESH_MS = 5_000;
const BUDGET_REFRESH_MS = 10_000;

export interface WalletSessionsOptions {
  config: AppConnectConfig;
  port: AppConnectPlatformPort;
  /** Defaults to IndexedDB (`evovote-app-connect`). */
  backend?: KeyRingBackend;
  now?: () => number;
  /** Turn off the hourly and post-write refresh timers (tests). */
  timers?: boolean;
  onWarning?: (message: string, error?: unknown) => void;
}

export class WalletSessions {
  private store: AppConnectKeyRingStore | null = null;
  private active: AppConnectSession | null = null;
  private status: WalletStatus = EMPTY_STATUS;
  private readonly listeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private firstRefresh: ReturnType<typeof setTimeout> | null = null;
  private budgetRefresh: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every activation and deactivation, so an activation finishing late can tell it was overtaken. */
  private activations = 0;
  /** Bumped by every sign-out; `signedOutAt` keeps each identity's latest, so an adoption can tell a sign-out overtook it. */
  private lifecycle = 0;
  private readonly signedOutAt = new Map<string, number>();
  private signedOutListener: ((identityId: string) => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly options: WalletSessionsOptions) {
    this.now = options.now ?? Date.now;
  }

  get config(): AppConnectConfig {
    return this.options.config;
  }

  get port(): AppConnectPlatformPort {
    return this.options.port;
  }

  /** The browser's key ring (also holds the wrapped pending sign-in request). */
  keyStore(): AppConnectKeyRingStore {
    this.store ??= new AppConnectKeyRingStore(this.options.backend ?? indexedDbKeyRingBackend('evovote-app-connect'));
    return this.store;
  }

  /** This browser's connection id for the network (hex), kept across sign-outs. */
  connectionId(): Promise<string> {
    return this.keyStore().connectionId(this.config.network);
  }

  getStatus(): WalletStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(next: Partial<WalletStatus>): void {
    this.status = { ...this.status, ...next };
    for (const listener of this.listeners) listener();
  }

  private publish(session: AppConnectSession | null): void {
    if (!session) {
      this.setStatus({ identityId: null, health: null, renewSoon: null, renewRequired: null });
      return;
    }
    const { health, renewSoon } = appConnectStanding(primaryKey(session, this.config.discussionContractId), this.now());
    this.setStatus({ identityId: session.identityId, health, renewSoon });
  }

  dismissSignedOut(): void {
    if (this.status.signedOutByWallet) this.setStatus({ signedOutByWallet: false });
  }

  /** The session for `identityId` (or any, without one) if this tab holds it. */
  current(identityId?: string): AppConnectSession | null {
    if (!this.active || (identityId !== undefined && this.active.identityId !== identityId)) return null;
    return this.active;
  }

  onSignedOut(listener: ((identityId: string) => void) | null): void {
    this.signedOutListener = listener;
  }

  /** Stores a verified grant as this browser's session and makes it active. Wipes the grant's keys. */
  async adopt(grant: AppConnectGrant): Promise<AppConnectSession> {
    const startedAt = this.lifecycle;
    const keys = new Map<string, Uint8Array>();
    let session: AppConnectSession;
    let stored = false;
    try {
      session = buildAppConnectSession(grant, {
        network: this.config.network,
        appId: this.config.appId,
        groupId: '',
        connectionId: await this.connectionId(),
        grantedAt: this.now(),
        keyRef: (privateKey, keyId) => {
          const ref = `key-${keyId}`;
          keys.set(ref, privateKey.slice());
          return ref;
        },
      });
      stored = await this.keyStore().save(session, keys);
    } finally {
      keys.forEach(clearSensitiveBytes);
      for (const granted of [...grant.authKeys, ...grant.encryptionKeys]) clearSensitiveBytes(granted.privateKey);
    }
    if (!stored) {
      // Another tab stored a newer grant for this identity meanwhile: use that one.
      const newer = await this.keyStore().load(this.config.network);
      if (!newer || newer.identityId !== session.identityId) throw new Error('The wallet sign-in was replaced; try again.');
      session = newer;
    }
    // Signed out of this identity while the grant was being stored: the
    // sign-out stands, so forget exactly this grant and activate nothing.
    if (this.signedOutSince(session.identityId, startedAt)) {
      if (stored) await this.clearStored(exactGrant(session));
      throw new Error('Signed out while the wallet was connecting.');
    }
    this.activate(session);
    return session;
  }

  /**
   * Loads this network's stored ring without touching the network. A ring
   * from another app id (a re-cut contract) or format covers nothing here and
   * is dropped. Null when there is none.
   */
  async restore(): Promise<AppConnectSession | null> {
    if (this.active) return this.active;
    const startedAt = this.lifecycle;
    let session: AppConnectSession | null;
    try {
      session = await this.keyStore().load(this.config.network);
    } catch (error) {
      this.options.onWarning?.('Wallet sign-in: could not read the key ring', error);
      return null;
    }
    if (!session || this.signedOutSince(session.identityId, startedAt)) return null;
    if (session.v !== APP_CONNECT_SESSION_VERSION || session.network !== this.config.network || session.appId !== this.config.appId) {
      await this.clearStored(exactGrant(session));
      return null;
    }
    if (this.active) return this.active;
    this.activate(session);
    return session;
  }

  private activate(session: AppConnectSession): void {
    this.activations++;
    this.active = session;
    this.setStatus({ renewRequired: null, signedOutByWallet: false });
    this.publish(session);
    this.startRefresh();
  }

  /** Drops this tab's in-memory session; the stored ring is left alone. */
  private deactivate(): void {
    this.activations++;
    this.active = null;
    this.stopRefresh();
    this.publish(null);
  }

  private async clearStored(match: SessionMatch): Promise<void> {
    try {
      await this.keyStore().clear(this.config.network, match);
    } catch (error) {
      this.options.onWarning?.('Wallet sign-in: could not clear the key ring', error);
    }
  }

  /** Sign-out: forgets this browser's ring for `identityId`, whichever tab stored it. The connection id stays. */
  async logout(identityId: string): Promise<void> {
    this.signedOutAt.set(identityId, ++this.lifecycle);
    if (this.active?.identityId === identityId) this.deactivate();
    await this.clearStored({ identityId });
  }

  /** Whether `identityId` was signed out after `lifecycle` read `since`. */
  private signedOutSince(identityId: string, since: number): boolean {
    return (this.signedOutAt.get(identityId) ?? 0) > since;
  }

  /** Whether this tab's active session is `session`'s grant, even after a refresh replaced the object. */
  private holds(session: AppConnectSession): boolean {
    return this.active !== null && isSameGrant(this.active, session);
  }

  /** Forgets exactly `session`, never a newer grant another tab has stored since. */
  async discard(session: AppConnectSession): Promise<void> {
    if (this.holds(session)) this.deactivate();
    await this.clearStored(exactGrant(session));
  }

  /** A stored private key (the caller wipes it after use), or null when the ring has none under `keyRef`. */
  privateKey(session: AppConnectSession, keyRef: string): Promise<Uint8Array | null> {
    return this.keyStore().privateKey(session, keyRef);
  }

  /**
   * Re-reads the ring's keys from chain: budgets and expiries are applied,
   * and a key the wallet revoked or superseded signs the user out. A failed
   * read changes nothing (being offline must not end a session).
   */
  async refresh(): Promise<void> {
    const session = this.active;
    if (!session) return;
    let reconciled: ReturnType<typeof reconcileSessionWithChain>;
    try {
      const identity = await this.port.getIdentityFresh(session.identityId);
      if (!identity) return;
      const budgeted = session.authKeys.filter((key) => key.totalBudget !== undefined).map((key) => key.keyId);
      const budgets =
        budgeted.length > 0
          ? await this.port.remainingBudgets(session.identityId, budgeted)
          : new Map<number, bigint | undefined>();
      reconciled = reconcileSessionWithChain(session, identity.publicKeys, budgets);
    } catch (error) {
      this.options.onWarning?.('Wallet sign-in: refresh failed', error);
      return;
    }
    if (this.active !== session) return;
    if (reconciled.revoked) {
      await this.signOutRevoked(session);
      return;
    }
    this.active = reconciled.session;
    this.publish(reconciled.session);
    await this.keyStore()
      .updateSession(reconciled.session)
      .catch((error: unknown) => this.options.onWarning?.('Wallet sign-in: could not keep the refreshed ring', error));
  }

  /**
   * `session`'s keys are revoked, superseded or unusable. Another tab may have
   * signed in again (which supersedes this grant): switch to that newer grant
   * if there is one; otherwise sign out, clearing this grant and nothing else.
   */
  async signOutRevoked(session: AppConnectSession): Promise<void> {
    if (!this.holds(session)) return;
    const startedAt = this.lifecycle;
    let stored: AppConnectSession | null = null;
    try {
      stored = await this.keyStore().load(this.config.network);
    } catch (error) {
      this.options.onWarning?.('Wallet sign-in: could not re-read the key ring', error);
    }
    if (stored && stored.identityId === session.identityId && isNewerGrant(stored, session)) {
      if (this.holds(session)) this.activate(stored);
      return;
    }
    await this.discard(session);
    // A sign-out overtook the revoke: it already ended this session.
    if (this.signedOutSince(session.identityId, startedAt)) return;
    this.setStatus({ signedOutByWallet: true });
    this.signedOutListener?.(session.identityId);
  }

  /**
   * What a refused write means for the ring (Yappr's APP_CONNECT_PROFILE.md,
   * "Errors"). Returns the failure when the code is a key-ring error.
   */
  async handleWriteFailure(identityId: string, code: number | null | undefined): Promise<AppConnectSigningFailure | null> {
    const classification = classifyAppConnectError(code);
    const session = this.active;
    if (!classification || !session || session.identityId !== identityId) return null;
    switch (classification.action) {
      case 'renew':
        this.setStatus({
          renewRequired:
            classification.failure === 'expired'
              ? 'expired'
              : classification.failure === 'allowance-spent'
                ? 'allowance-spent'
                : 'insufficient-allowance',
        });
        await this.refresh();
        break;
      case 'logout':
        await this.signOutRevoked(session);
        break;
      case 'invalidate':
      case 'handoff':
        // The selector should make these impossible; re-read so the ring matches the chain.
        this.options.onWarning?.(`Wallet sign-in: a write was refused with code ${code}`);
        await this.refresh();
        break;
    }
    return classification.failure;
  }

  /** A write signed by the ring landed: re-read the budget shortly (coalesced across a burst). */
  noteWriteLanded(identityId: string): void {
    if (this.active?.identityId !== identityId || this.budgetRefresh || this.options.timers === false) return;
    this.budgetRefresh = setTimeout(() => {
      this.budgetRefresh = null;
      void this.refresh();
    }, BUDGET_REFRESH_MS);
  }

  private startRefresh(): void {
    if (this.refreshTimer || this.options.timers === false || typeof window === 'undefined') return;
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    // First check soon after start, off the restore path.
    this.firstRefresh = setTimeout(() => void this.refresh(), FIRST_REFRESH_MS);
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.firstRefresh) clearTimeout(this.firstRefresh);
    if (this.budgetRefresh) clearTimeout(this.budgetRefresh);
    this.refreshTimer = null;
    this.firstRefresh = null;
    this.budgetRefresh = null;
  }
}
