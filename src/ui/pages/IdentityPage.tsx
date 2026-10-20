import { useState } from 'react';
import { CHARTERS_CONTRACT_ID } from '../../charters/documents';
import { dashText } from '../../model/credits';
import { keyRoleText, type KeyBounds } from '../../identity/keys';
import {
  documentSigningProblem,
  forgetStepKey,
  refreshIdentity,
  signOut,
  useIdentitySession,
  type IdentitySession,
} from '../../identity/session';
import { errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { endDate, shortId } from '../format';
import { SignInPanel } from '../identity/SignInPanel';
import { SigningProblemNote } from '../identity/SigningProblemNote';
import { RenewWallet } from '../identity/RenewWallet';

function boundsText(b: KeyBounds | undefined): string {
  if (!b) return 'any contract';
  switch (b.kind) {
    case 'singleContract':
      return shortId(b.contractId, 5);
    case 'documentType':
      return `${shortId(b.contractId, 5)} / ${b.documentTypeName}`;
    case 'contractGroup':
      return `group ${shortId(b.groupId, 5)}`;
    case 'unknown':
      return 'unreadable bounds';
  }
}

/** How this session signs: the wallet's key (allowance, expiry), the pasted key, or both. */
function SignedInWith({ session }: { session: IdentitySession }) {
  const walletKey = session.wallet?.keys[0];
  return (
    <>
      {session.via === 'wallet' && (
        <div>
          <dt className="mono-label">signed in with</dt>
          <dd>
            Dash Wallet{walletKey ? ` · key #${walletKey.keyId} for comments` : ''}
            {walletKey?.totalBudget !== undefined &&
              ` · ${dashText(walletKey.remainingBudget ?? walletKey.totalBudget)} of ${dashText(walletKey.totalBudget)} allowance left`}
            {walletKey?.expiresAt !== undefined && ` · until ${endDate(walletKey.expiresAt)}`}
          </dd>
        </div>
      )}
      {session.pastedKey && (
        <div>
          <dt className="mono-label">{session.via === 'wallet' ? 'key for charter steps' : 'signed in with'}</dt>
          <dd>
            key #{session.pastedKey.keyId} ({keyRoleText(session.pastedKey)}), in this tab only
            {session.via === 'wallet' && (
              <>
                {' '}
                <button className="link-button" onClick={forgetStepKey}>
                  Forget it
                </button>
              </>
            )}
          </dd>
        </div>
      )}
    </>
  );
}

/** `#/me`: sign in, and see the identity, its balance and its keys. */
export function IdentityPage({ network }: { network: Network }) {
  const session = useIdentitySession();
  const [refreshError, setRefreshError] = useState<string | null>(null);

  if (!session) {
    return (
      <div className="about-page">
        <h1>My identity</h1>
        <p>
          Sign in to comment on contests and to take part in moderator elections: file reasons and a charter,
          ask to join a team, and apply for a contract&apos;s moderation seat.
        </p>
        <SignInPanel network={network} mode="page" />
      </div>
    );
  }

  const problem = documentSigningProblem(session, { contractId: CHARTERS_CONTRACT_ID, documentType: 'submittedCharter' });
  const inUse = new Set([...(session.wallet?.keys.map((k) => k.keyId) ?? []), ...(session.pastedKey ? [session.pastedKey.keyId] : [])]);
  return (
    <div className="about-page">
      <h1>{session.names[0] ?? 'My identity'}</h1>
      <dl className="kv-table">
        <div>
          <dt className="mono-label">identity</dt>
          <dd className="mono">{session.identityId}</dd>
        </div>
        <div>
          <dt className="mono-label">names</dt>
          <dd>{session.names.length > 0 ? session.names.join(', ') : 'none'}</dd>
        </div>
        <div>
          <dt className="mono-label">balance</dt>
          <dd>{dashText(session.balance)}</dd>
        </div>
        <SignedInWith session={session} />
      </dl>
      <RenewWallet network={network} session={session} />
      {problem && <SigningProblemNote problem={problem} />}

      <h2 className="section-title">Keys</h2>
      <table className="key-table">
        <thead>
          <tr>
            <th>#</th>
            <th>purpose · level</th>
            <th>type</th>
            <th>bound to</th>
            <th>state</th>
          </tr>
        </thead>
        <tbody>
          {session.keys.map((k) => (
            <tr key={k.keyId} className={inUse.has(k.keyId) ? 'current' : ''}>
              <td className="mono">{k.keyId}</td>
              <td>{keyRoleText(k)}</td>
              <td className="mono">{k.keyType}</td>
              <td className="mono">{boundsText(k.bounds)}</td>
              <td>
                {k.disabled ? 'disabled' : k.readOnly ? 'read-only' : 'enabled'}
                {inUse.has(k.keyId) && ' · in use'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="modal-actions">
        <button
          className="vote-button ghost"
          onClick={() => {
            setRefreshError(null);
            refreshIdentity().catch((e: unknown) => setRefreshError(errorMessage(e)));
          }}
        >
          Refresh
        </button>
        <button className="vote-button ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      {session.via === 'wallet' && (
        <p className="wallet-note">
          Signing out forgets Dash Wallet&apos;s key in this browser. The key stays on your identity until you
          revoke it in Dash Wallet.
        </p>
      )}
      {refreshError && <p className="mono-label error">Could not refresh: {refreshError}</p>}
      <p className="fine-print">
        <a href="#/m">Moderated contracts →</a>
      </p>
    </div>
  );
}
