import { useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { CHARTERS_CONTRACT_ID, type CharterProposal } from '../../charters/documents';
import { forEachConcurrent } from '../../discovery/concurrency';
import { proposalHref } from '../../charters/pollKey';
import { fetchJoinRequestsByMember, fetchProposal, fetchProposalsByLeader } from '../../charters/reads';
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
import { targetName } from '../../kinds/charter';
import { errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { CopyButton } from '../components/CopyButton';
import { dateText, firstSentence, shortId } from '../format';
import { RenewWallet } from '../identity/RenewWallet';
import { SignInPanel } from '../identity/SignInPanel';
import { SigningProblemNote } from '../identity/SigningProblemNote';
import { useAsync } from '../useAsync';

function boundsText(b: KeyBounds | undefined) {
  if (!b) return 'Any contract';
  switch (b.kind) {
    case 'singleContract':
      return <span className="mono">{shortId(b.contractId)}</span>;
    case 'documentType':
      return (
        <>
          <span className="mono">{shortId(b.contractId)}</span> / {b.documentTypeName}
        </>
      );
    case 'contractGroup':
      return (
        <>
          Group <span className="mono">{shortId(b.groupId)}</span>
        </>
      );
    case 'unknown':
      return 'Unreadable bounds';
  }
}

/** How this session signs: the wallet's key (allowance, expiry), the pasted key, or both. */
function SignedInWith({ session }: { session: IdentitySession }) {
  const walletKey = session.wallet?.keys[0];
  return (
    <>
      {session.via === 'wallet' && (
        <div>
          <dt>Signed in with</dt>
          <dd>
            Dash Wallet{walletKey ? ` · key #${walletKey.keyId} for comments` : ''}
            {walletKey?.totalBudget !== undefined &&
              ` · ${dashText(walletKey.remainingBudget ?? walletKey.totalBudget)} of ${dashText(walletKey.totalBudget)} allowance left`}
            {walletKey?.expiresAt !== undefined && ` · until ${dateText(walletKey.expiresAt)}`}
          </dd>
        </div>
      )}
      {session.pastedKey && (
        <div>
          <dt>{session.via === 'wallet' ? 'Key for charter steps' : 'Signed in with'}</dt>
          <dd>
            The private key you pasted (key #{session.pastedKey.keyId}, {session.pastedKey.securityLevel.toLowerCase()}{' '}
            security), held in this tab only
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

/** The teams this identity asked to join, each linked to its proposal. */
function MyJoinRequests({ sdk, identityId }: { sdk: EvoSDK; identityId: string }) {
  const asked = useAsync(async () => {
    const requests = await fetchJoinRequestsByMember(sdk, identityId);
    // Each proposal once, a few at a time. One that cannot be read is still listed, without its title.
    const proposals = new Map<string, CharterProposal | 'gone' | 'failed'>();
    await forEachConcurrent([...new Set(requests.map((r) => r.submittedCharterId))], 4, async (id) => {
      proposals.set(id, await fetchProposal(sdk, id).then((p) => p ?? 'gone', () => 'failed' as const));
    });
    return requests.map((request) => ({ request, proposal: proposals.get(request.submittedCharterId) ?? 'failed' }));
  }, [sdk, identityId]);
  return (
    <section className="hub-section">
      <h2 className="section-title">Teams you asked to join</h2>
      {asked.status === 'loading' && (
        <p className="meta" role="status">
          Reading your join requests…
        </p>
      )}
      {asked.status === 'error' && (
        <p className="meta error">
          Could not read your join requests.{' '}
          <button className="link-button" onClick={asked.reload}>
            Try again
          </button>
        </p>
      )}
      {asked.status === 'ok' && asked.value.length === 0 && (
        <p className="meta">You have not asked to join a team.</p>
      )}
      {asked.status === 'ok' && asked.value.length > 0 && (
        <ul className="proposal-list">
          {asked.value.map(({ request, proposal }) => {
            const when = request.createdAtMs ? `asked ${dateText(request.createdAtMs, { time: false })}` : 'asked';
            return (
              <li key={request.id}>
                {typeof proposal === 'object' ? (
                  <a className="proposal-item" href={proposalHref(proposal.targetContractId, proposal.id)}>
                    <span className="proposal-item-title">{firstSentence(proposal.description)}</span>
                    <span className="proposal-item-by">
                      For Moderators of {targetName(proposal.targetContractId)} · {when}
                    </span>
                  </a>
                ) : (
                  <div className="proposal-item">
                    <span className="proposal-item-title">
                      {proposal === 'gone' ? 'A proposal that no longer exists' : 'A proposal that could not be read right now'}
                    </span>
                    <span className="proposal-item-by">
                      Proposal <span className="mono">{shortId(request.submittedCharterId)}</span> · {when}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
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
            team, ask to join one, or apply for a seat. Each write is a small fee paid from your identity&apos;s
            balance; applying for a seat also takes a 0.5 DASH contest fund.
          </p>
        </header>
        <SignInPanel network={network} mode="page" />
        <p className="fine-print">
          Voting is separate. Masternode owners vote with their masternode&apos;s voting key through{' '}
          <strong>Vote with masternode</strong> in the header; no identity or sign-in is needed for that.
        </p>
      </div>
    );
  }

  const problem = documentSigningProblem(session, { contractId: CHARTERS_CONTRACT_ID, documentType: 'submittedCharter' });
  const inUse = new Set([...(session.wallet?.keys.map((k) => k.keyId) ?? []), ...(session.pastedKey ? [session.pastedKey.keyId] : [])]);
  return (
    <div className="about-page identity-page">
      <header className="page-header">
        <h1 className="page-title">{session.names[0] ?? 'Your identity'}</h1>
        <p className="page-byline">
          <span>
            Identity <span className="mono" title={session.identityId}>{shortId(session.identityId)}</span>{' '}
            <CopyButton text={session.identityId} label="Copy identity id" />
          </span>
          <span>{session.via === 'wallet' ? 'Signed in with Dash Wallet' : 'Signed in for this tab only'}</span>
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
        <SignedInWith session={session} />
      </dl>
      <RenewWallet network={network} session={session} />
      {problem && <SigningProblemNote problem={problem} />}
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
      {refreshError && <p className="meta error">Could not refresh: {refreshError}</p>}

      <MyProposals sdk={sdk} identityId={session.identityId} />
      <MyJoinRequests sdk={sdk} identityId={session.identityId} />

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
              <tr key={k.keyId} className={inUse.has(k.keyId) ? 'current' : ''}>
                <td className="mono">{k.keyId}</td>
                <td>{keyRoleText(k)}</td>
                <td className="mono">{k.keyType}</td>
                <td>{boundsText(k.bounds)}</td>
                <td>
                  {k.disabled ? 'Disabled' : k.readOnly ? 'Read-only' : 'Enabled'}
                  {inUse.has(k.keyId) && ' · in use'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
