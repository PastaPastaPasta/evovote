import { useEffect, useState } from 'react';
import { AboutPage } from './components/AboutPage';
import { ContestList } from './components/ContestList';
import { ContestPage } from './components/ContestPage';
import { MnDrawer } from './components/MnDrawer';
import { VoteModal } from './components/VoteModal';
import { initMnStore, useMasternodes } from './lib/mn';
import { useRoute } from './lib/router';
import {
  errorMessage,
  loadSdk,
  storedNetwork,
  switchNetwork,
  type Network,
  type SdkHandle,
} from './lib/sdk';
import { useTheme, type ThemePref } from './lib/theme';
import type { VoteChoice } from './lib/vote';

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
        <path
          d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"
          fill="currentColor"
        />
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

export function App() {
  // Constant for the page's lifetime: switchNetwork() persists and reloads.
  const network: Network = storedNetwork();
  const [sdkState, setSdkState] = useState<SdkState>({ status: 'loading' });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingVote, setPendingVote] = useState<{
    label: string;
    choice: VoteChoice;
  } | null>(null);
  const route = useRoute();
  const masternodes = useMasternodes();
  const { pref: themePref, cycle: cycleTheme } = useTheme();

  useEffect(() => {
    initMnStore(network);
    let cancelled = false;
    loadSdk(network)
      .then((handle) => {
        if (!cancelled) setSdkState({ status: 'ready', handle });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setSdkState({ status: 'error', message: errorMessage(e) });
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
          <img className="brand-glyph" src="./favicon.svg" alt="" />
          <span>
            <span className="brand-mark">EVO</span>VOTE
          </span>
          <span className="brand-tag">contested Dash usernames</span>
        </a>
        <nav className="topbar-nav">
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
