import { useEffect, useState } from 'react';
import { AboutPage } from './components/AboutPage';
import { ContestList } from './components/ContestList';
import { ContestPage } from './components/ContestPage';
import { MnDrawer } from './components/MnDrawer';
import { VoteModal } from './components/VoteModal';
import { initMnStore, useMasternodes } from './lib/mn';
import { useRoute } from './lib/router';
import {
  loadSdk,
  storedNetwork,
  switchNetwork,
  type Network,
  type SdkHandle,
} from './lib/sdk';
import type { VoteChoice } from './lib/vote';

type SdkState =
  | { status: 'loading' }
  | { status: 'ready'; handle: SdkHandle }
  | { status: 'error'; message: string };

export function App() {
  const [network] = useState<Network>(storedNetwork);
  const [sdkState, setSdkState] = useState<SdkState>({ status: 'loading' });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingVote, setPendingVote] = useState<{
    label: string;
    choice: VoteChoice;
  } | null>(null);
  const route = useRoute();
  const masternodes = useMasternodes();

  useEffect(() => {
    initMnStore(network);
    let cancelled = false;
    loadSdk(network)
      .then((handle) => {
        if (!cancelled) setSdkState({ status: 'ready', handle });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setSdkState({
            status: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [network]);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark">EVO</span>VOTE
          <span className="brand-tag">contested Dash usernames</span>
        </a>
        <nav className="topbar-nav">
          <a href="#/about">About</a>
          <button className="mn-button" onClick={() => setDrawerOpen(true)}>
            Masternodes
            {masternodes.length > 0 && (
              <span className="mn-count">{masternodes.length}</span>
            )}
          </button>
          <select
            className="network-select"
            value={network}
            aria-label="Network"
            onChange={(e) => switchNetwork(e.target.value as Network)}
          >
            <option value="mainnet">mainnet</option>
            <option value="testnet">testnet</option>
          </select>
        </nav>
      </header>

      <main className="content">
        {sdkState.status === 'loading' && (
          <div className="sdk-loading">
            <div className="spinner" aria-hidden="true" />
            <p>Connecting to Dash Platform ({network})…</p>
            <p className="mono-label">
              first load fetches the SDK (~9 MB), then it's cached
            </p>
          </div>
        )}
        {sdkState.status === 'error' && (
          <div className="sdk-loading">
            <p className="error">
              Could not connect to Platform: {sdkState.message}
            </p>
            <button className="vote-button" onClick={() => location.reload()}>
              Retry
            </button>
          </div>
        )}
        {sdkState.status === 'ready' && (
          <>
            {route.page === 'home' && (
              <ContestList sdk={sdkState.handle.sdk} network={network} />
            )}
            {route.page === 'contest' && (
              <ContestPage
                sdk={sdkState.handle.sdk}
                network={network}
                label={route.label}
                onVote={(choice) => setPendingVote({ label: route.label, choice })}
              />
            )}
            {route.page === 'about' && <AboutPage />}
          </>
        )}
      </main>

      <footer className="footer">
        <span>
          Reads and votes go straight to Dash Platform from your browser — no
          backend, no tracking.
        </span>
        <span>
          <a
            href="https://github.com/PastaPastaPasta/evovote"
            target="_blank"
            rel="noreferrer"
          >
            source
          </a>{' '}
          ·{' '}
          <a href="https://dash.org" target="_blank" rel="noreferrer">
            dash.org
          </a>
        </span>
      </footer>

      {drawerOpen && (
        <MnDrawer network={network} onClose={() => setDrawerOpen(false)} />
      )}
      {pendingVote && (
        <VoteModal
          network={network}
          label={pendingVote.label}
          choice={pendingVote.choice}
          onClose={() => setPendingVote(null)}
          onOpenMasternodes={() => setDrawerOpen(true)}
        />
      )}
    </div>
  );
}
