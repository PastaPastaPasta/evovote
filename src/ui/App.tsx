import { useEffect, useRef, useState } from 'react';
import type { Contest, VoteChoice } from '../model/contest';
import { loadSdk, type SdkHandle } from '../sdk/connection';
import { errorMessage } from '../sdk/errors';
import { currentNetwork, switchNetwork, type Network } from '../sdk/network';
import { useIdentitySession } from '../identity/session';
import { initKeyring, useMasternodes } from '../voting/keyring';
import { KeyringPanel, MnDrawer } from './components/KeyringPanel';
import { VoteModal } from './components/VoteModal';
import { TechnicalDetail } from './components/TechnicalDetail';
import { AboutPage } from './pages/AboutPage';
import { ContestPage } from './pages/ContestPage';
import { ContractPage } from './pages/ContractPage';
import { ElectionHubPage } from './pages/ElectionHubPage';
import { IdentityPage } from './pages/IdentityPage';
import { ModeratedDirectoryPage } from './pages/ModeratedDirectoryPage';
import { ProposalPage } from './pages/ProposalPage';
import { OverviewPage } from './pages/OverviewPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { navSection, sameView, useRoute, type NavSection, type Route } from './router';
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

/** How long the SDK download runs before the page says why it takes a while. */
const SLOW_DOWNLOAD_MS = 2_500;

/**
 * What the page says while Platform connects: first the SDK download (a
 * large chunk, cached by the browser after the first visit), then the
 * connection itself.
 */
function connectingText(phase: 'download' | 'connect', slow: boolean, network: Network): string {
  if (phase === 'connect') return `Connecting to Dash Platform (${network})…`;
  return slow
    ? 'Downloading the Platform SDK… A first visit takes a moment; later visits load it from your browser’s cache.'
    : 'Loading the Platform SDK…';
}

type DirectoryRoute = Extract<Route, { page: 'home' | 'kind' }>;

/** The contest directory: its own element whatever the SDK's state, so connecting never remounts it. */
function isDirectory(route: Route): route is DirectoryRoute {
  return route.page === 'home' || route.page === 'kind';
}

function Page({
  route,
  handle,
  network,
  onVote,
}: {
  route: Exclude<Route, DirectoryRoute>;
  handle: SdkHandle;
  network: Network;
  onVote: (contest: Contest, choice: VoteChoice, names?: ReadonlyMap<string, string>) => void;
}) {
  switch (route.page) {
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
          <header className="page-header">
            <h1 className="page-title">Vote with a masternode</h1>
          </header>
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
      return <IdentityPage sdk={handle.sdk} network={network} />;
    case 'notFound':
      return (
        <PlaceholderPage title="Not found">
          <p>There is no page at this address.</p>
        </PlaceholderPage>
      );
  }
}

const NAV: Array<{ href: string; label: string; section: NavSection }> = [
  { href: '#/', label: 'Contests', section: 'contests' },
  { href: '#/m', label: 'Moderation', section: 'moderation' },
  { href: '#/about', label: 'About', section: 'about' },
];

/**
 * On a route change: back to the top, and focus the new page's h1 so a
 * screen reader announces it and Tab starts from the page, not the header.
 * The h1 can render a moment late (pages show their header while loading),
 * so it is looked for a few times. Switching tabs on the contest list keeps
 * the scroll and focus.
 */
function useRouteFocus(route: Route): void {
  const previous = useRef<Route | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = route;
    if (!before || sameView(before, route)) return;
    window.scrollTo(0, 0);
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focus = () => {
      const h1 = document.querySelector<HTMLElement>('#main h1');
      if (h1) {
        if (!h1.hasAttribute('tabindex')) h1.tabIndex = -1;
        h1.focus({ preventScroll: true });
      } else if (tries++ < 20) {
        timer = setTimeout(focus, 100);
      } else {
        // A page with no h1 (the contest list): start from the content.
        document.getElementById('main')?.focus({ preventScroll: true });
      }
    };
    focus();
    return () => clearTimeout(timer);
  }, [route]);
}

export function App() {
  // Constant for the page's lifetime: switchNetwork() persists and reloads.
  const [network] = useState<Network>(currentNetwork);
  const [sdkState, setSdkState] = useState<SdkState>({ status: 'loading' });
  const [sdkPhase, setSdkPhase] = useState<'download' | 'connect'>('download');
  const [slowDownload, setSlowDownload] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingVote, setPendingVote] = useState<{ contest: Contest; choice: VoteChoice; names?: ReadonlyMap<string, string> } | null>(
    null,
  );
  const [voteRound, setVoteRound] = useState(0);
  const route = useRoute();
  const section = navSection(route);
  const masternodes = useMasternodes();
  const session = useIdentitySession();
  const identityLabel = session ? (session.names[0] ?? shortId(session.identityId)) : 'Sign in';
  const { pref: themePref, cycle: cycleTheme } = useTheme();
  useRouteFocus(route);

  useEffect(() => {
    initKeyring(network);
    let cancelled = false;
    const slowTimer = setTimeout(() => setSlowDownload(true), SLOW_DOWNLOAD_MS);
    // The same module loadSdk imports: once it is here, only the connection is left.
    void import('@dashevo/evo-sdk')
      .then(() => {
        if (!cancelled) setSdkPhase('connect');
      })
      .catch(() => {
        // loadSdk reports the failure.
      })
      .finally(() => clearTimeout(slowTimer));
    loadSdk(network)
      .then((handle) => {
        if (!cancelled) setSdkState({ status: 'ready', handle });
      })
      .catch((e: unknown) => {
        if (!cancelled) setSdkState({ status: 'error', message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, [network]);
  const connecting = connectingText(sdkPhase, slowDownload, network);
  const onVote = (contest: Contest, choice: VoteChoice, names?: ReadonlyMap<string, string>) =>
    setPendingVote({ contest, choice, names });

  const themeLabel = `Theme: ${themePref === 'system' ? 'match system' : themePref}. Change theme`;
  return (
    <div className={`app network-${network}`}>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          // Hash routes: a plain #main link would navigate away.
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="#/" aria-label="EvoVote home">
          <img className="brand-glyph" src="./favicon.svg" alt="" />
          <span className="brand-word">
            <span className="brand-mark">Evo</span>Vote
          </span>
          <span className="brand-tag">Contested resources on Dash Platform</span>
        </a>
        <nav className="topbar-nav" aria-label="Main">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} aria-current={section === item.section ? 'page' : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
        <label className={`network-control network-control-${network}`} title="Network">
          <span className="visually-hidden">Network</span>
          <select value={network} onChange={(e) => switchNetwork(e.target.value as Network)}>
            <option value="testnet">Testnet</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </label>
        <button className="icon-button theme-toggle" onClick={cycleTheme} title={themeLabel} aria-label={themeLabel}>
          <ThemeIcon pref={themePref} />
        </button>
        <button className="mn-button" onClick={() => setDrawerOpen(true)}>
          <span className="mn-button-long">Vote with masternode</span>
          <span className="mn-button-short">Masternodes</span>
          {masternodes.length > 0 && (
            <span className="mn-count" aria-label={`${masternodes.length} added`}>
              {masternodes.length}
            </span>
          )}
        </button>
        <a
          className={session ? 'signin-link signed-in' : 'signin-link'}
          href="#/me"
          aria-current={section === 'me' ? 'page' : undefined}
          title={session ? `Signed in as ${identityLabel}` : undefined}
          aria-label={session ? `Signed in as ${identityLabel}` : undefined}
        >
          <span className="signin-full">{identityLabel}</span>
          {session && (
            <span className="signin-initial" aria-hidden="true">
              {identityLabel.charAt(0).toUpperCase()}
            </span>
          )}
        </a>
      </header>

      {network === 'mainnet' && (
        <div className="network-banner" role="note">
          EvoVote v2 is built for testnet. Mainnet support arrives with protocol 14.
        </div>
      )}

      <main className="content" id="main" tabIndex={-1}>
        {isDirectory(route) && (
          // One element from first paint on: it lays itself out (and shows
          // cached results) while Platform connects, and keeps its search,
          // sort and page when the SDK arrives or tabs change. If Platform
          // cannot be reached, the cache stays on screen with the error.
          <OverviewPage
            key={voteRound}
            sdk={sdkState.status === 'ready' ? sdkState.handle.sdk : undefined}
            network={network}
            kindFilter={route.page === 'kind' ? route.kind : undefined}
            connecting={connecting}
            sdkError={sdkState.status === 'error' ? sdkState.message : undefined}
          />
        )}
        {sdkState.status === 'loading' && !isDirectory(route) && (
          <div className="sdk-loading" role="status">
            <div className="spinner" aria-hidden="true" />
            <p>{connecting}</p>
          </div>
        )}
        {sdkState.status === 'error' && !isDirectory(route) && (
          <div className="sdk-loading" role="alert">
            <p className="error">Could not connect to Dash Platform.</p>
            <TechnicalDetail>{sdkState.message}</TechnicalDetail>
            <button className="vote-button" onClick={() => location.reload()}>
              Retry
            </button>
          </div>
        )}
        {sdkState.status === 'ready' && !isDirectory(route) && (
          <Page key={voteRound} route={route} handle={sdkState.handle} network={network} onVote={onVote} />
        )}
      </main>

      <footer className="footer">
        <span>
          Reads and votes go straight from your browser to Dash Platform. No backend, no tracking.
        </span>
        <span className="footer-links">
          <a href="https://github.com/PastaPastaPasta/evovote" target="_blank" rel="noreferrer">
            Source
          </a>
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
          names={pendingVote.names}
          onClose={(sent) => {
            setPendingVote(null);
            // After a broadcast, remount the page so it re-reads the
            // (invalidated) vote state. A cancelled vote keeps the page, and
            // the button that opened the dialog gets its focus back.
            if (sent) setVoteRound((n) => n + 1);
          }}
          onOpenMasternodes={() => setDrawerOpen(true)}
        />
      )}
    </div>
  );
}
