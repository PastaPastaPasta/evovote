import { useState } from 'react';
import { CHARTERS_CONTRACT_ID } from '../../charters/documents';
import { dashText } from '../../model/credits';
import { keyRoleText } from '../../identity/keys';
import {
  documentSigningProblem,
  refreshIdentity,
  signOut,
  useIdentitySession,
} from '../../identity/session';
import { errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { shortId } from '../format';
import { SignInPanel } from '../identity/SignInPanel';

/** `#/me`: sign in, and see the identity, its balance and its keys. */
export function IdentityPage({ network }: { network: Network }) {
  const session = useIdentitySession();
  const [refreshError, setRefreshError] = useState<string | null>(null);

  if (!session) {
    return (
      <div className="about-page">
        <h1>My identity</h1>
        <p>
          Sign in to take part in moderator elections: file reasons and a charter, ask to join a team, and
          apply for a contract&apos;s moderation seat.
        </p>
        <SignInPanel network={network} />
      </div>
    );
  }

  const problem = documentSigningProblem(session, CHARTERS_CONTRACT_ID);
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
        <div>
          <dt className="mono-label">signed in with</dt>
          <dd>
            key #{session.loginKey.keyId} ({keyRoleText(session.loginKey)})
          </dd>
        </div>
      </dl>
      {problem && <p className="page-note error">{problem}</p>}

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
            <tr key={k.keyId} className={k.keyId === session.loginKey.keyId ? 'current' : ''}>
              <td className="mono">{k.keyId}</td>
              <td>{keyRoleText(k)}</td>
              <td className="mono">{k.keyType}</td>
              <td className="mono">
                {k.bounds
                  ? `${shortId(k.bounds.contractId, 5)}${k.bounds.documentTypeName ? ` / ${k.bounds.documentTypeName}` : ''}`
                  : 'any contract'}
              </td>
              <td>
                {k.disabled ? 'disabled' : k.readOnly ? 'read-only' : 'enabled'}
                {k.keyId === session.loginKey.keyId && ' · in use'}
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
        <button className="vote-button ghost" onClick={signOut}>
          Sign out
        </button>
      </div>
      {refreshError && <p className="mono-label error">Could not refresh: {refreshError}</p>}
      <p className="fine-print">
        <a href="#/m">Moderated contracts →</a>
      </p>
    </div>
  );
}
