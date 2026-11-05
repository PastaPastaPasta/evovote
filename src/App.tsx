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
  type Network,
  type SdkHandle,
} from './lib/sdk';
import type { VoteChoice } from './lib/vote';

type SdkState =
  | { status: 'loading' }
  | { status: 'ready'; handle: SdkHandle }
  | { status: 'error'; message: string };

export function App() {
  // Switching the shell network reloads the page with one SDK instance.
  const network: Network = storedNetwork();
  const requestedNetwork = new URLSearchParams(location.search).get('network');
  const unsupportedNetwork = requestedNetwork && !['mainnet', 'testnet', 'main', 'test'].includes(requestedNetwork);
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
          setSdkState({ status: 'error', message: errorMessage(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [network]);

  return (
    <div className="app">
      <dashhq-bar product="vote" network={network} networks="mainnet testnet" sticky="">
        <nav slot="nav" aria-label="Name contests">
          <a href="#/" aria-current={route.page !== 'about' ? 'page' : undefined}>Contests</a>
          <a href="#/about" aria-current={route.page === 'about' ? 'page' : undefined}>About</a>
        </nav>
        <div slot="actions">
          <button className="mn-button" title="Masternodes" aria-label={`Masternodes${masternodes.length ? ` (${masternodes.length})` : ''}`} onClick={() => setDrawerOpen(true)}>
            <svg className="mn-button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="8" cy="8" r="5" /><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3" /></svg>
            <span className="mn-button-label">Masternodes</span>{masternodes.length > 0 && <span className="mn-count">{masternodes.length}</span>}
          </button>
        </div>
      </dashhq-bar>
      {unsupportedNetwork && <aside className="handoff" role="alert">This EvoVote build supports Mainnet and Testnet. The requested network <bdi>{requestedNetwork}</bdi> is unavailable; showing Mainnet.</aside>}
      <aside className="handoff" aria-label="Continue in Governance">
        <strong>Name contests now live in Governance.</strong>
        <p>Same contests, same voting keys, plus proposals. You can keep using EvoVote here.</p>
        <a href={window.dashhq.href('gov', route.page === 'contest' ? '/names/' + encodeURIComponent(route.label) : '/names')}>Open in Governance →</a>
      </aside>

      <main className="content" id="main">
        {route.page === 'home' && <h1 className="page-heading">Name contests</h1>}
        {route.page === 'about' && <AboutPage />}
        {route.page !== 'about' && sdkState.status === 'loading' && (
          <div className="sdk-loading">
            <div className="spinner" aria-hidden="true" />
            <p>Connecting to Dash Platform ({network})…</p>
            <p className="mono-label">Contests appear as Platform answers. This can take a few seconds.</p>
          </div>
        )}
        {route.page !== 'about' && sdkState.status === 'error' && (
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
          </>
        )}
      </main>

      <dashhq-footer product="vote" source="https://github.com/PastaPastaPasta/evovote">
        <p>Reads and votes go straight to Platform. Voting keys stay in this tab. <a href="#/about">About EvoVote</a></p>
      </dashhq-footer>

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
