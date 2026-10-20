import { useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { CHARTERS_CONTRACT_ID } from '../../charters/documents';
import { proposalHref } from '../../charters/pollKey';
import { fetchProposalsByLeader } from '../../charters/reads';
import { dashText } from '../../model/credits';
import { keyRoleText } from '../../identity/keys';
import {
  documentSigningProblem,
  refreshIdentity,
  signOut,
  useIdentitySession,
} from '../../identity/session';
import { targetName } from '../../kinds/charter';
import { errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { CopyButton } from '../components/CopyButton';
import { dateText, firstSentence, shortId } from '../format';
import { SignInPanel } from '../identity/SignInPanel';
import { useAsync } from '../useAsync';

/** The proposals this identity leads, each linked to its page. */
function MyProposals({ sdk, identityId }: { sdk: EvoSDK; identityId: string }) {
  const led = useAsync(() => fetchProposalsByLeader(sdk, identityId), [sdk, identityId]);
  return (
    <section className="hub-section">
      <h2 className="section-title">Moderation teams you lead</h2>
      {led.status === 'loading' && (
        <p className="meta" role="status">
          Reading your proposals…
        </p>
      )}
      {led.status === 'error' && (
        <p className="meta error">
          Could not read your proposals.{' '}
          <button className="link-button" onClick={led.reload}>
            Try again
          </button>
        </p>
      )}
      {led.status === 'ok' && led.value.length === 0 && (
        <p className="meta">
          You have not proposed a team. <a href="#/m">See the moderator elections →</a>
        </p>
      )}
      {led.status === 'ok' && led.value.length > 0 && (
        <ul className="proposal-list">
          {led.value.map((p) => (
            <li key={p.id}>
              <a className="proposal-item" href={proposalHref(p.targetContractId, p.id)}>
                <span className="proposal-item-title">{firstSentence(p.description)}</span>
                <span className="proposal-item-by">
                  For Moderators of {targetName(p.targetContractId)}
                  {p.createdAtMs ? ` · filed ${dateText(p.createdAtMs, { time: false })}` : ''}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `#/me`: sign in, and see the identity, its balance, its keys and its moderation activity. */
export function IdentityPage({ sdk, network }: { sdk: EvoSDK; network: Network }) {
  const session = useIdentitySession();
  const [refreshError, setRefreshError] = useState<string | null>(null);

  if (!session) {
    return (
      <div className="about-page identity-page">
        <header className="page-header">
          <h1 className="page-title">Sign in</h1>
          <p className="page-lead">
            Sign in with your Dash identity to comment on contests and take part in moderator elections: propose a
            team, ask to join one, or apply for a seat. Each of those is a small fee paid from your identity&apos;s
            balance.
          </p>
        </header>
        <SignInPanel network={network} />
        <p className="fine-print">
          Voting is separate. Masternode owners vote with their masternode&apos;s voting key through{' '}
          <strong>Vote with masternode</strong> in the header; no identity or sign-in is needed for that.
        </p>
      </div>
    );
  }

  const problem = documentSigningProblem(session, CHARTERS_CONTRACT_ID);
  return (
    <div className="about-page identity-page">
      <header className="page-header">
        <h1 className="page-title">{session.names[0] ?? 'Your identity'}</h1>
        <p className="page-byline">
          <span>
            Identity <span className="mono" title={session.identityId}>{shortId(session.identityId)}</span>{' '}
            <CopyButton text={session.identityId} label="Copy identity id" />
          </span>
          <span>Signed in for this tab only</span>
        </p>
      </header>
      <dl className="kv-table">
        <div>
          <dt>Balance</dt>
          <dd>{dashText(session.balance)}</dd>
        </div>
        <div>
          <dt>Usernames</dt>
          <dd>{session.names.length > 0 ? session.names.join(', ') : 'None'}</dd>
        </div>
        <div>
          <dt>Signed in with</dt>
          <dd>
            Key #{session.loginKey.keyId} ({keyRoleText(session.loginKey)})
          </dd>
        </div>
      </dl>
      {problem && <p className="page-note error">{problem}</p>}
      <div className="modal-actions start">
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
      {refreshError && <p className="meta error">Could not refresh: {refreshError}</p>}

      <MyProposals sdk={sdk} identityId={session.identityId} />

      <details className="rules">
        <summary>Your identity&apos;s keys · {session.keys.length}</summary>
        <table className="key-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Purpose · level</th>
              <th>Type</th>
              <th>Limited to</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {session.keys.map((k) => (
              <tr key={k.keyId} className={k.keyId === session.loginKey.keyId ? 'current' : ''}>
                <td className="mono">{k.keyId}</td>
                <td>{keyRoleText(k)}</td>
                <td className="mono">{k.keyType}</td>
                <td>
                  {k.bounds ? (
                    <>
                      <span className="mono">{shortId(k.bounds.contractId)}</span>
                      {k.bounds.documentTypeName ? ` / ${k.bounds.documentTypeName}` : ''}
                    </>
                  ) : (
                    'Any contract'
                  )}
                </td>
                <td>
                  {k.disabled ? 'Disabled' : k.readOnly ? 'Read-only' : 'Enabled'}
                  {k.keyId === session.loginKey.keyId && ' · in use'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
