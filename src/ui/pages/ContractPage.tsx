import { useEffect, useRef, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import {
  BROWSE_MAX_CONTESTS,
  browseContract,
  emptyContractView,
  indexSource,
  type BrowsedContest,
  type BrowsedType,
  type ContractView,
} from '../../discovery/contractBrowser';
import { kindFor } from '../../kinds/registry';
import { phaseOf, type Phase } from '../../model/contest';
import { displayIndexValue } from '../../model/indexValue';
import type { Network } from '../../sdk/network';
import { BallotBar } from '../components/BallotBar';
import { CopyButton } from '../components/CopyButton';
import { IndexRules } from '../components/IndexRules';
import { KindTitle } from '../components/KindTitle';
import { ReadIssues } from '../components/ReadIssues';
import { countdown, plural, shortId } from '../format';
import { useNow } from '../hooks';
import { rememberContract } from '../recentContracts';
import { pollHref } from '../router';

const PHASE_RANK: Record<Phase, number> = { open: 0, closing: 1, unknown: 2, decided: 3 };

function phaseOfEntry(entry: BrowsedContest) {
  const winner = typeof entry.state === 'object' ? entry.state.winner : undefined;
  return phaseOf({ endsAtMs: entry.summary.endsAtMs, winner });
}

/** Open first (soonest closing), then closing, then unknown, then decided; stable within each. */
function sortEntries(entries: BrowsedContest[]): BrowsedContest[] {
  return entries
    .map((entry, i) => ({ entry, i, rank: PHASE_RANK[phaseOfEntry(entry)] }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.entry.summary.endsAtMs ?? 0) - (b.entry.summary.endsAtMs ?? 0) ||
        a.i - b.i,
    )
    .map((x) => x.entry);
}

function EntryStatus({ entry, now }: { entry: BrowsedContest; now: number }) {
  const { state, summary } = entry;
  if (state === 'loading') return <span className="ledger-ends mono-label">…</span>;
  if (state === 'error') return <span className="ledger-ends mono-label error">unavailable</span>;
  const phase = phaseOfEntry(entry);
  if (phase === 'decided') {
    const kind = state.winner?.kind;
    return (
      <span className={`ledger-ends mono-label ${kind === 'identity' ? 'won' : kind === 'locked' ? 'locked' : ''}`}>
        {kind === 'identity' ? 'awarded' : kind === 'locked' ? 'locked' : 'decided'}
      </span>
    );
  }
  if (phase === 'open' && summary.endsAtMs) {
    const timing = countdown(summary.endsAtMs, now);
    return (
      <span className={`ledger-ends mono-label${timing.urgent ? ' urgent' : ''}`}>
        closes in {timing.text}
      </span>
    );
  }
  if (phase === 'closing') return <span className="ledger-ends mono-label">awaiting finalization</span>;
  return <span className="ledger-ends mono-label">awaiting result</span>;
}

function ContestRow({ entry, now }: { entry: BrowsedContest; now: number }) {
  const { state, summary } = entry;
  const kind = kindFor(summary.key);
  const loaded = typeof state === 'object' ? state : undefined;
  const ended = phaseOfEntry(entry) === 'decided';
  return (
    <li>
      <a className={ended ? 'ledger-row ended' : 'ledger-row'} href={pollHref(summary.keyString)}>
        <span className="ledger-name">
          {kind.id === 'generic' ? (
            // The document type heads the section, so the row shows just the values.
            <span className="kind-title">
              {summary.key.indexValues.map(displayIndexValue).join(' / ')}
            </span>
          ) : (
            <KindTitle contest={loaded ?? summary} />
          )}
          {loaded && loaded.tally.contenders.length >= 2 && (
            <span className="contest-flag">{loaded.tally.contenders.length} contenders</span>
          )}
        </span>
        <span className="ledger-bar">
          {state === 'loading' && <span className="bar-skeleton" />}
          {state === 'error' && <span className="mono-label error">tally unavailable</span>}
          {loaded && <BallotBar state={loaded.tally} mini showLock={kind.choices(loaded).includes('lock')} />}
        </span>
        <span className="ledger-votes mono-label">
          {loaded ? plural(loaded.tally.total, 'vote') : ''}
        </span>
        <EntryStatus entry={entry} now={now} />
      </a>
    </li>
  );
}

function TypeSection({
  type,
  failed,
  now,
}: {
  type: BrowsedType;
  failed: boolean;
  now: number;
}) {
  const { index, contests, sweeping } = type;
  return (
    <section className="contract-type">
      <h2 className="section-title">
        {index.documentTypeName} <span className="mono-label">{plural(contests.length, 'contested value')}</span>
        {sweeping && <span className="mono-label"> · reading…</span>}
      </h2>
      <IndexRules index={index} />
      {contests.length > 0 && (
        <ol className="ledger">
          {sortEntries(contests).map((entry) => (
            <ContestRow key={entry.summary.keyString} entry={entry} now={now} />
          ))}
        </ol>
      )}
      {!sweeping && contests.length === 0 && (
        <p className="page-note">
          {failed
            ? 'None found, but a read failed (see above).'
            : 'Nothing has been contested on this index yet.'}
        </p>
      )}
    </section>
  );
}

/** `#/c/<contractId>`: the contested indices of one contract and every value contested on them. */
export function ContractPage({
  sdk,
  network,
  contractId,
}: {
  sdk: EvoSDK;
  network: Network;
  contractId: string;
}) {
  const [limit, setLimit] = useState(BROWSE_MAX_CONTESTS);
  const [view, setView] = useState<ContractView>(() => emptyContractView(contractId));
  const now = useNow();

  const showedList = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    // "Show more" re-runs the browse: keep the list on screen until the new
    // sweep has listed everything, instead of blanking it and losing scroll.
    const keepPrevious = showedList.current;
    void browseContract(sdk, contractId, {
      maxContests: limit,
      signal: abort.signal,
      onUpdate: (next) => {
        if (abort.signal.aborted) return;
        if (keepPrevious && (next.load !== 'ready' || next.types.some((t) => t.sweeping))) return;
        if (next.load === 'ready') showedList.current = true;
        setView(next);
      },
    });
    return () => abort.abort();
  }, [sdk, contractId, limit]);

  const exists = view.load === 'ready';
  useEffect(() => {
    if (exists) rememberContract(network, contractId);
  }, [exists, network, contractId]);

  const sweeping = view.types.some((t) => t.sweeping);
  const capped = !sweeping && view.caps.some((c) => c.limit === limit);

  return (
    <div className="contest-page contract-page">
      <a href="#/" className="back-link">
        ← All contests
      </a>
      <h1 className="contest-title">
        Contract <span className="mono" title={contractId}>{shortId(contractId, 6)}</span>{' '}
        <CopyButton text={contractId} label="Copy contract id" />
      </h1>
      <p className="mono-label poll-meta">
        {contractId} · {network}
      </p>

      {view.load === 'loading' && <p className="page-note">Reading the contract from Platform…</p>}
      {view.load === 'not-found' && (
        <p className="page-note error">No data contract with this id exists on {network}.</p>
      )}
      {view.load === 'error' && (
        <>
          <ReadIssues failures={view.failures} caps={[]} />
          <p className="page-note error">Could not read this contract on {network}.</p>
        </>
      )}

      {exists && (
        <>
          <p className="page-note">
            {plural(view.documentTypes.length, 'document type')}
            {view.types.length === 0
              ? ', none with a contested index. Nothing on this contract goes to a masternode vote.'
              : `, ${view.types.length} with a contested index (${view.types
                  .map((t) => t.index.documentTypeName)
                  .join(', ')}).`}
          </p>
          <ReadIssues failures={view.failures} caps={view.caps} />
          {view.types.map((type) => (
            <TypeSection
              key={`${type.index.documentTypeName}/${type.index.indexName}`}
              type={type}
              failed={view.failures.some((f) => f.source === indexSource(type.index))}
              now={now}
            />
          ))}
          {capped && (
            <button className="vote-button ghost" onClick={() => setLimit(limit + BROWSE_MAX_CONTESTS)}>
              Show up to {limit + BROWSE_MAX_CONTESTS} per index
            </button>
          )}
        </>
      )}
    </div>
  );
}
