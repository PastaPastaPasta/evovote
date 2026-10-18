import { useEffect, useState } from 'react';
import type { Contest, VoteChoice } from '../model/contest';
import { loadSdk, type SdkHandle } from '../sdk/connection';
import { errorMessage } from '../sdk/errors';
import { currentNetwork, switchNetwork, type Network } from '../sdk/network';
import { useIdentitySession } from '../identity/session';
import { initKeyring, useMasternodes } from '../voting/keyring';
import { KeyringPanel, MnDrawer } from './components/KeyringPanel';
import { VoteModal } from './components/VoteModal';
import { AboutPage } from './pages/AboutPage';
import { ContestPage } from './pages/ContestPage';
import { ContractPage } from './pages/ContractPage';
import { ElectionHubPage } from './pages/ElectionHubPage';
import { IdentityPage } from './pages/IdentityPage';
import { ModeratedDirectoryPage } from './pages/ModeratedDirectoryPage';
import { ProposalPage } from './pages/ProposalPage';
import { OverviewPage } from './pages/OverviewPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { useRoute, type Route } from './router';
import { useTheme, type ThemePref } from './theme';
import { shortId } from './format';

function ThemeIcon({ pref }: { pref: ThemePref }) {
  if (pref === 'light') {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="2.5" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="21.5" y2="12" />
          <line x1="5" y1="5" x2="6.8" y2="6.8" />
          <line x1="17.2" y1="17.2" x2="19" y2="19" />
          <line x1="5" y1="19" x2="6.8" y2="17.2" />
          <line x1="17.2" y1="6.8" x2="19" y2="5" />
        </g>
      </svg>
    );
  }
  if (pref === 'dark') {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" />
    </svg>
  );
}

type SdkState =
  | { status: 'loading' }
  | { status: 'ready'; handle: SdkHandle }
  | { status: 'error'; message: string };

function Page({
  route,
  handle,
  network,
  onVote,
}: {
  route: Route;
  handle: SdkHandle;
  network: Network;
  onVote: (contest: Contest, choice: VoteChoice) => void;
}) {
  switch (route.page) {
    case 'home':
      return <OverviewPage sdk={handle.sdk} network={network} />;
    case 'kind':
      // Same element as 'home': switching tabs keeps the streamed list.
      return <OverviewPage sdk={handle.sdk} network={network} kindFilter={route.kind} />;
    case 'poll':
      return (
        <ContestPage
          key={route.keyString}
          handle={handle}
          network={network}
          keyString={route.keyString}
          onVote={onVote}
        />
      );
    case 'mn':
      return (
        <div className="about-page">
          <h1>My masternodes</h1>
          <KeyringPanel network={network} />
        </div>
      );
    case 'about':
      return <AboutPage />;
    case 'moderatedDirectory':
      return <ModeratedDirectoryPage sdk={handle.sdk} network={network} />;
    case 'moderated':
      return route.charterId ? (
        <ProposalPage key={route.charterId} handle={handle} target={route.target} charterId={route.charterId} />
      ) : (
        <ElectionHubPage key={route.target} handle={handle} target={route.target} />
      );
    case 'contract':
      return (
        <ContractPage
          key={route.contractId}
          sdk={handle.sdk}
          network={network}
          contractId={route.contractId}
        />
      );
    case 'me':
      return <IdentityPage network={network} />;
    case 'notFound':
      return (
        <PlaceholderPage title="Not found">
          <p>There is no page at this address.</p>
        </PlaceholderPage>
      );
  }
}

export function App() {
  // Constant for the page's lifetime: switchNetwork() persists and reloads.
  const [network] = useState<Network>(currentNetwork);
  const [sdkState, setSdkState] = useState<SdkState>({ status: 'loading' });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingVote, setPendingVote] = useState<{ contest: Contest; choice: VoteChoice } | null>(
    null,
  );
  const [voteRound, setVoteRound] = useState(0);
  const route = useRoute();
  const masternodes = useMasternodes();
  const session = useIdentitySession();
  const identityLabel = session ? (session.names[0] ?? shortId(session.identityId, 4)) : 'Sign in';
  const { pref: themePref, cycle: cycleTheme } = useTheme();

  useEffect(() => {
    initKeyring(network);
    let cancelled = false;
    loadSdk(network)
      .then((handle) => {
        if (!cancelled) setSdkState({ status: 'ready', handle });
      })
      .catch((e: unknown) => {
        if (!cancelled) setSdkState({ status: 'error', message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [network]);

  return (
    <div className={`app network-${network}`}>
      <header className="topbar">
        <a className="brand" href="#/">
          <img className="brand-glyph" src="./favicon.svg" alt="" />
          <span>
            <span className="brand-mark">EVO</span>VOTE
          </span>
          <span className="brand-tag">contested resources on Dash Platform</span>
        </a>
        <nav className="topbar-nav">
          <a href="#/m">Moderators</a>
          <a href="#/me">{identityLabel}</a>
          <a href="#/about">About</a>
          <button
            className="theme-toggle"
            onClick={cycleTheme}
            title={`Theme: ${themePref} — click to change`}
            aria-label={`Theme: ${themePref} — click to change`}
          >
            <ThemeIcon pref={themePref} />
          </button>
          <button className="mn-button" onClick={() => setDrawerOpen(true)}>
            Masternodes
            {masternodes.length > 0 && <span className="mn-count">{masternodes.length}</span>}
          </button>
          <select
            className="network-select"
            value={network}
            aria-label="Network"
            onChange={(e) => switchNetwork(e.target.value as Network)}
          >
            <option value="testnet">testnet</option>
            <option value="mainnet">mainnet</option>
          </select>
        </nav>
      </header>

      {network === 'mainnet' && (
        <div className="network-banner" role="note">
          v2 targets testnet; mainnet support arrives with protocol 14.
        </div>
      )}

      <main className="content">
        {sdkState.status === 'loading' && (
          <div className="sdk-loading">
            <div className="spinner" aria-hidden="true" />
            <p>Connecting to Dash Platform ({network})…</p>
            <p className="mono-label">first load fetches the SDK, then it's cached</p>
          </div>
        )}
        {sdkState.status === 'error' && (
          <div className="sdk-loading">
            <p className="error">Could not connect to Platform: {sdkState.message}</p>
            <button className="vote-button" onClick={() => location.reload()}>
              Retry
            </button>
          </div>
        )}
        {sdkState.status === 'ready' && (
          <Page
            key={voteRound}
            route={route}
            handle={sdkState.handle}
            network={network}
            onVote={(contest, choice) => setPendingVote({ contest, choice })}
          />
        )}
      </main>

      <footer className="footer">
        <span>
          Reads and votes go straight to Dash Platform from your browser — no backend, no
          tracking.
        </span>
        <span>
          <a href="https://github.com/PastaPastaPasta/evovote" target="_blank" rel="noreferrer">
            source
          </a>{' '}
          ·{' '}
          <a href="https://dash.org" target="_blank" rel="noreferrer">
            dash.org
          </a>
        </span>
      </footer>

      {drawerOpen && <MnDrawer network={network} onClose={() => setDrawerOpen(false)} />}
      {pendingVote && (
        <VoteModal
          network={network}
          contest={pendingVote.contest}
          choice={pendingVote.choice}
          onClose={() => {
            setPendingVote(null);
            // Remount the page so it re-reads the (invalidated) vote state.
            setVoteRound((n) => n + 1);
          }}
          onOpenMasternodes={() => setDrawerOpen(true)}
        />
      )}
    </div>
  );
}
