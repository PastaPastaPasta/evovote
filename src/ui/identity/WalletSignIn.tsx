import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clearWalletReturn, useWalletReturn } from '../../appconnect/callback';
import { APP_CONNECT_BUDGET } from '../../appconnect/config';
import type { AppConnectUnavailableReason, VerifiedCandidate } from '../../appconnect/loginFlow';
import { resumeWalletSession, signInWithWallet } from '../../identity/session';
import { walletSessions } from '../../appconnect/runtime';
import { fetchUsernames } from '../../kinds/dpns';
import { dashText } from '../../model/credits';
import { loadSdk } from '../../sdk/connection';
import { errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { shortId } from '../format';
import { useAsync } from '../useAsync';
import { useWalletSignIn } from './useWalletSignIn';
import { WalletQr } from './WalletQr';

const UNAVAILABLE_COPY: Record<AppConnectUnavailableReason, { title: string; text: string; retry: boolean }> = {
  'not-configured': {
    title: 'Wallet sign-in is not set up on this site',
    text: 'Use a private key instead.',
    retry: false,
  },
  'network-not-ready': {
    title: 'Wallet sign-in is not available on this network yet',
    text: 'It needs Dash Platform protocol 14. Use a private key instead.',
    retry: false,
  },
  offline: {
    title: 'Could not reach Dash Platform',
    text: 'Check your connection, then try again.',
    retry: true,
  },
  storage: {
    title: 'Wallet sign-in needs browser storage',
    text: 'This browser blocks site storage, which keeps the wallet’s key between visits. Allow it for this site (or leave private browsing), then try again.',
    retry: true,
  },
};

/** What a wallet's return link can report besides `ok`. */
const WALLET_STATUS_COPY: Record<string, { title: string; text: string }> = {
  declined: { title: 'You declined in Dash Wallet', text: 'Nothing was added to your identity. Start again whenever you like.' },
  stale: { title: 'That sign-in code expired', text: 'Codes last 10 minutes. Start again for a fresh one.' },
  unsupported: {
    title: 'This Dash Wallet can’t sign in to EvoVote',
    text: 'It needs a build with App Connect (today the DashPay iOS test build). Use a private key instead.',
  },
  invalid: { title: 'Dash Wallet could not read the request', text: 'Start again for a fresh code.' },
  failed: { title: 'Dash Wallet could not finish the sign-in', text: 'Nothing changed here. Start again for a fresh code.' },
};
const UNKNOWN_STATUS = { title: 'Dash Wallet did not sign you in', text: 'Start again for a fresh code.' };

function Spinner() {
  return <span className="wallet-spinner" aria-hidden="true" />;
}

function useCandidateName(network: Network, id: string): string | undefined {
  const names = useAsync(async () => fetchUsernames((await loadSdk(network)).sdk, id), [network, id]);
  return names.status === 'ok' ? names.value[0] : undefined;
}

function CandidateName({ network, id }: { network: Network; id: string }) {
  const name = useCandidateName(network, id);
  return name ? <strong>{name}</strong> : <span className="mono">{shortId(id, 6)}</span>;
}

/** One answer: "Continue as <name>?" with the identity's username (or full id when it has none). */
function SingleCandidate({
  network,
  id,
  onAccept,
  onReject,
}: {
  network: Network;
  id: string;
  onAccept: (identityId: string) => void;
  onReject: () => void;
}) {
  const name = useCandidateName(network, id);
  return (
    <div className="wallet-confirm" data-testid="wallet-confirm">
      <p className="wallet-state-title">Dash Wallet approved. Is this you?</p>
      <div className="wallet-candidate">
        {name ? <strong>{name}</strong> : <span className="wallet-candidate-none">Identity without a username</span>}
        <span className="mono wallet-candidate-id">{id}</span>
      </div>
      <div className="wallet-actions">
        <button className="vote-button" onClick={() => onAccept(id)}>
          Continue as {name ? <strong>{name}</strong> : <span className="mono">{shortId(id, 6)}</span>}
        </button>
        <button className="vote-button ghost" onClick={onReject}>
          That’s not me
        </button>
      </div>
      <p className="wallet-note">Anyone who scans this code can answer it, so only continue if this is your identity.</p>
    </div>
  );
}

function ConfirmIdentity({
  network,
  candidates,
  onAccept,
  onReject,
}: {
  network: Network;
  candidates: VerifiedCandidate[];
  onAccept: (identityId: string) => void;
  onReject: () => void;
}) {
  if (candidates.length === 1) {
    return <SingleCandidate network={network} id={candidates[0].identityId} onAccept={onAccept} onReject={onReject} />;
  }
  return (
    <div className="wallet-confirm" data-testid="wallet-chooser">
      <p className="wallet-state-title">More than one identity answered. Choose yours.</p>
      <ul className="wallet-candidates">
        {candidates.map((c) => (
          <li key={c.identityId}>
            <button className="vote-button ghost" onClick={() => onAccept(c.identityId)}>
              <CandidateName network={network} id={c.identityId} />{' '}
              <span className="mono-label">{shortId(c.identityId, 6)}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="link-button" onClick={onReject}>
        None of these is me
      </button>
    </div>
  );
}

function StateCard({
  title,
  text,
  tone = 'neutral',
  children,
}: {
  title: string;
  text?: string;
  tone?: 'neutral' | 'warn' | 'ok';
  children?: ReactNode;
}) {
  return (
    <div className={`wallet-state ${tone}`} role="status" aria-live="polite">
      <p className="wallet-state-title">{title}</p>
      {text && <p className="wallet-state-text">{text}</p>}
      {children && <div className="wallet-actions">{children}</div>}
    </div>
  );
}

/**
 * "Sign in with Dash Wallet": a QR code and an "Open in Dash Wallet" link for
 * an App Connect request. When a wallet answers, the answer is verified on
 * chain and the user confirms which identity it is ("Continue as …" or
 * "That's not me") before anything is stored. `identityHint` renews the
 * signed-in identity's key instead. (From Yappr's
 * components/auth/app-connect-login-panel.tsx.)
 */
export function WalletSignIn({
  network,
  identityHint,
  onSignedIn,
}: {
  network: Network;
  identityHint?: string;
  onSignedIn?: () => void;
}) {
  const walletReturn = useWalletReturn();
  // A return link handed to another tab, or one that reported a decline,
  // waits for the user before starting a request here.
  const held = walletReturn !== null && walletReturn.phase !== 'here';
  const [signing, setSigning] = useState<'idle' | 'running'>('idle');
  const [signInError, setSignInError] = useState<string | null>(null);
  const [restarted, setRestarted] = useState(false);
  // After the wallet refused a code (declined, stale…), the next start makes a new one.
  const [startFresh, setStartFresh] = useState(false);
  // The wallet's keys are stored but the identity read failed: retry the read, not the grant.
  const [resumable, setResumable] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { state, walletStatus, actions } = useWalletSignIn(network, {
    enabled: !held && !resumable,
    identityHint,
    fresh: startFresh,
    // Runs from the hook's subscription, after this render: `accept` is defined by then.
    onCandidates: (candidates) => {
      // A renewal names its identity: its verified answer is accepted without asking.
      if (identityHint && candidates.some((c) => c.identityId === identityHint)) accept(identityHint);
    },
  });

  const accept = (identityId: string) => {
      const grant = actions.accept(identityId);
      if (!grant) return;
      setSigning('running');
      setSignInError(null);
      clearWalletReturn();
      signInWithWallet(network, grant)
        .then(() => {
          if (mounted.current) setSigning('idle');
          onSignedIn?.();
        })
        .catch((e: unknown) => {
          if (!mounted.current) return;
          setSigning('idle');
          if (walletSessions(network)?.current()) {
            // The keys are stored: only reading the identity failed. No new grant needed.
            setResumable(true);
            setSignInError(`Dash Wallet approved, but your identity could not be read: ${errorMessage(e)}`);
            return;
          }
          setSignInError(`Could not finish signing in: ${errorMessage(e)} Try again with a new code.`);
          actions.restart();
        });
  };

  if (walletReturn?.phase === 'checking') {
    return (
      <StateCard title="Finishing sign-in…">
        <Spinner />
      </StateCard>
    );
  }
  if (walletReturn?.phase === 'other-tab') {
    return (
      <StateCard
        title="You’re signing in on your other EvoVote tab"
        text="Dash Wallet sent you back here, but the tab that showed the code is finishing the sign-in. You can close this one."
      >
        <button className="vote-button ghost" onClick={clearWalletReturn}>
          Sign in in this tab instead
        </button>
      </StateCard>
    );
  }
  if (walletReturn?.phase === 'status') {
    const copy = WALLET_STATUS_COPY[walletReturn.status] ?? UNKNOWN_STATUS;
    return (
      <StateCard title={copy.title} text={copy.text} tone="warn">
        <button
          className="vote-button"
          onClick={() => {
            setStartFresh(true);
            clearWalletReturn();
          }}
        >
          Start again
        </button>
      </StateCard>
    );
  }

  if (resumable) {
    return (
      <StateCard title="Almost signed in" text={signInError ?? undefined} tone="warn">
        <button
          className="vote-button"
          onClick={() => {
            setSigning('running');
            resumeWalletSession(network)
              .then(() => {
                if (!mounted.current) return;
                setResumable(false);
                setSignInError(null);
                setSigning('idle');
                onSignedIn?.();
              })
              .catch((e: unknown) => {
                if (!mounted.current) return;
                setSigning('idle');
                setSignInError(`Your identity still could not be read: ${errorMessage(e)}`);
              });
          }}
        >
          Try again
        </button>
      </StateCard>
    );
  }

  if (signing === 'running') {
    return (
      <StateCard title={identityHint ? 'Renewing…' : 'Signing you in…'}>
        <Spinner />
      </StateCard>
    );
  }

  const restart = () => {
    setSignInError(null);
    actions.restart();
  };

  switch (state.phase) {
    case 'checking':
      return (
        <StateCard title="Preparing a sign-in code…">
          <Spinner />
        </StateCard>
      );
    case 'unavailable': {
      const copy = UNAVAILABLE_COPY[state.reason];
      return (
        <StateCard title={copy.title} text={copy.text} tone="warn">
          {copy.retry && (
            <button className="vote-button ghost" onClick={actions.retry}>
              Try again
            </button>
          )}
        </StateCard>
      );
    }
    case 'waiting': {
      const status = walletStatus ? (WALLET_STATUS_COPY[walletStatus] ?? UNKNOWN_STATUS) : null;
      return (
        <div className="wallet-waiting">
          {signInError && <p className="page-note error">{signInError}</p>}
          {status && (
            <div className="page-note warn" role="alert">
              <strong>{status.title}.</strong> {status.text}{' '}
              <button className="link-button" onClick={restart}>
                New code
              </button>
            </div>
          )}
          {restarted && !status && (
            <p className="page-note warn" role="alert">
              Someone else may have scanned your code. Here is a new one: only scan it with your own wallet.
            </p>
          )}
          <WalletQr uri={state.uri} />
          <p className="wallet-polling" role="status" aria-live="polite">
            <Spinner />
            <span>
              Waiting for Dash Wallet… approve <strong>EvoVote</strong> there, then come back to this page.
            </span>
          </p>
        </div>
      );
    }
    case 'timeout':
      return (
        <StateCard
          title="No answer from Dash Wallet yet"
          text="If you approved it in the wallet, check again. Codes last 10 minutes; after that you get a fresh one."
        >
          <button className="vote-button" onClick={actions.checkAgain}>
            Check again
          </button>
          <button className="link-button" onClick={restart}>
            New code
          </button>
        </StateCard>
      );
    case 'too-many':
      return (
        <StateCard title="Let’s start again" text="Too many answers came in for this code. Here is a fresh one to scan." tone="warn">
          <button className="vote-button" onClick={restart}>
            New code
          </button>
        </StateCard>
      );
    case 'confirm':
      if (identityHint) {
        return (
          <StateCard title="Renewing…">
            <Spinner />
          </StateCard>
        );
      }
      return (
        <ConfirmIdentity
          network={network}
          candidates={state.candidates}
          onAccept={accept}
          onReject={() => {
            setRestarted(true);
            actions.reject();
          }}
        />
      );
  }
}

/** One line on what approving does, for the card's intro. */
export const WALLET_GRANT_TEXT = `Approving adds one key to your identity that can post comments here, with an allowance of ${dashText(APP_CONNECT_BUDGET)} for 90 days. EvoVote never sees your recovery phrase or master key.`;
