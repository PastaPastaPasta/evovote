import { useEffect, useMemo, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { knownContractById } from '../../config/knownContracts';
import { electedOf } from '../../charters/declaration';
import {
  addContract,
  collectDirectoryIds,
  mergeDirectory,
  removeContract,
  useAddedContracts,
  type DirectorySource,
} from '../../charters/directory';
import { PHASE_TEXT } from '../../charters/phase';
import { moderatedHref } from '../../charters/pollKey';
import { fetchElectionStatus, type ElectionStatus } from '../../charters/reads';
import { forEachConcurrent } from '../../discovery/concurrency';
import { contractJson, fetchContract } from '../../discovery/contracts';
import { fetchUsernames } from '../../kinds/dpns';
import { errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { IdentityName } from '../components/IdentityName';
import { ReadIssues } from '../components/ReadIssues';
import { TechnicalDetail } from '../components/TechnicalDetail';
import { countdown, dateText, plural, shortId } from '../format';
import { useNow } from '../hooks';
import { OPEN_PHASES, phaseTone, winningScore } from '../charters/standing';
import { useAsync } from '../useAsync';

interface Card {
  status?: ElectionStatus;
  /** The owner's first DPNS name, for a contract the site has no name for. */
  ownerName?: string;
  error?: string;
}

/** One card's election and, for an unnamed contract, its owner's name. Never throws. */
async function loadCard(sdk: EvoSDK, id: string): Promise<Card> {
  let status: ElectionStatus;
  try {
    status = await fetchElectionStatus(sdk, id);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  if (knownContractById(id) || !status.contractFound) return { status };
  // Best effort: the card falls back to what the contract moderates.
  try {
    const contract = await fetchContract(sdk, id);
    const owner = contract && (contractJson(sdk, contract) as { ownerId?: unknown }).ownerId;
    return { status, ownerName: typeof owner === 'string' ? (await fetchUsernames(sdk, owner))[0] : undefined };
  } catch {
    return { status };
  }
}

/** A card whose election could not be read (as opposed to one that is closed). */
function unreadable(card: Card | undefined): boolean {
  return !!card && (!card.status || card.status.timing.phase === 'unknown');
}

/** "Yappr Social", else what the contract moderates and who owns it, else its short id. */
function cardTitle(id: string, card: Card | undefined): string {
  const known = knownContractById(id)?.name;
  if (known) return known;
  const elected = card?.status?.moderation && electedOf(card.status.moderation);
  const types = elected ? Object.keys(elected.moderatedDocumentTypes) : [];
  if (types.length > 0) {
    const what = `${types.join(', ')} moderation`;
    return `${what.charAt(0).toUpperCase()}${what.slice(1)}${card?.ownerName ? ` · ${card.ownerName}` : ''}`;
  }
  return card?.ownerName ? `${card.ownerName}'s contract` : `Contract ${shortId(id)}`;
}

/** One sentence: who holds the seat, or what is open and until when. */
function CardStatus({ sdk, card, now }: { sdk: EvoSDK; card: Card | undefined; now: number }) {
  if (!card) return <span className="bar-skeleton card-skeleton" aria-label="Loading" />;
  if (card.error || !card.status) return <span className="meta error">Could not be read right now.</span>;
  const s = card.status;
  if (s.contractFound === false) return <span className="meta error">No such contract on this network.</span>;
  const { phase, joinClosesAtMs, endsAtMs, opensAtMs } = s.timing;
  if (s.team) {
    const score = winningScore(s.contest?.tally.contenders ?? [], s.team.leaderId);
    const decidedAt = s.contest?.winner?.decidedAtMs;
    return (
      <span>
        Seated: <IdentityName sdk={sdk} id={s.team.leaderId} />
        {decidedAt && ` since ${dateText(decidedAt, { time: false })}`}
        {score && (score === 'unopposed' ? ' · unopposed' : ` · won ${score}`)}
      </span>
    );
  }
  switch (phase) {
    case 'join-window':
      return <span>{joinClosesAtMs ? `Applications close in ${countdown(joinClosesAtMs, now).text}` : 'Applications open'}</span>;
    case 'voting':
      return <span>{endsAtMs ? `Voting ends in ${countdown(endsAtMs, now).text}` : 'Voting'}</span>;
    case 'notice':
      return (
        <span>
          {opensAtMs && Number.isFinite(opensAtMs) ? `Applications open ${dateText(opensAtMs)}` : 'Applications never open'}
        </span>
      );
    case 'proposals':
      return <span>{plural(s.proposals.length, 'proposal')} filed · nobody has applied yet</span>;
    case 'no-election':
      return <span>Open for proposals · no team has filed yet</span>;
    case 'not-elected':
      return <span className="meta">This contract does not hold moderator elections.</span>;
    default:
      return <span>{PHASE_TEXT[phase]}</span>;
  }
}

function group(card: Card | undefined): 'loading' | 'open' | 'decided' | 'other' {
  if (!card) return 'loading';
  const phase = card.status?.timing.phase;
  if (!phase) return 'other';
  if (OPEN_PHASES.has(phase)) return 'open';
  if (phase === 'seated' || phase === 'decided') return 'decided';
  return 'other';
}

function ElectionCard({
  sdk,
  network,
  id,
  sources,
  card,
  now,
}: {
  sdk: EvoSDK;
  network: Network;
  id: string;
  sources: DirectorySource[];
  card: Card | undefined;
  now: number;
}) {
  const known = knownContractById(id);
  const phase = card?.status?.timing.phase;
  const tone = phaseTone(phase);
  return (
    <li className="election-card">
      <a className="election-card-link" href={moderatedHref(id)}>
        <span className="election-card-head">
          <span className="election-card-title">{cardTitle(id, card)}</span>
          {phase && <span className={`chip tone-${tone}`}>{PHASE_TEXT[phase]}</span>}
        </span>
        <span className="election-card-status">
          <CardStatus sdk={sdk} card={card} now={now} />
        </span>
        <span className="meta">
          {known?.note ? `${known.note} · ` : ''}
          <span className="mono" title={id}>
            {shortId(id)}
          </span>
          {sources.includes('added') && ' · added by you'}
        </span>
      </a>
      {sources.includes('added') && (
        <button className="link-button election-card-remove" onClick={() => removeContract(network, id)} aria-label={`Remove ${cardTitle(id, card)} from your list`}>
          Remove
        </button>
      )}
    </li>
  );
}

/** `#/m`: every contract with a moderator election this site knows of, open ones first. */
export function ModeratedDirectoryPage({ sdk, network }: { sdk: EvoSDK; network: Network }) {
  const added = useAddedContracts(network);
  // The sweep does not depend on the user's list, so adding an id does not re-run it.
  const ids = useAsync(() => collectDirectoryIds(sdk, network), [sdk, network]);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [input, setInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const now = useNow();

  const entries = useMemo(
    () => (ids.status === 'ok' ? mergeDirectory(ids.value.known, ids.value.contested, added) : []),
    [ids, added],
  );
  useEffect(() => {
    let cancelled = false;
    void forEachConcurrent(entries, 4, async ({ id }) => {
      const card = await loadCard(sdk, id);
      if (!cancelled) setCards((prev) => ({ ...prev, [id]: card }));
    });
    return () => {
      cancelled = true;
    };
    // Re-read when the list changes (by ids, not by array identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk, entries.map((e) => e.id).join(',')]);

  const add = () => {
    const problem = addContract(network, input);
    setAddError(problem ?? null);
    if (!problem) setInput('');
  };

  const byGroup = (g: ReturnType<typeof group>) => entries.filter((e) => group(cards[e.id]) === g);
  const open = byGroup('open');
  const decided = byGroup('decided');
  const other = byGroup('other');
  const loading = byGroup('loading');
  const failed = other.filter((e) => unreadable(cards[e.id])).length;
  const list = (items: typeof entries) => (
    <ol className="election-cards">
      {items.map(({ id, sources }) => (
        <ElectionCard key={id} sdk={sdk} network={network} id={id} sources={sources} card={cards[id]} now={now} />
      ))}
    </ol>
  );

  return (
    <div className="directory-page">
      <header className="page-header">
        <h1 className="page-title">Moderator elections</h1>
        <p className="page-lead">
          Some Dash Platform apps let masternodes elect who moderates them. Teams publish a charter saying what they
          would remove and why, then apply for the seat; masternodes vote, and the winner moderates the app.
        </p>
      </header>

      {ids.status === 'loading' && (
        <p className="page-note" role="status">
          Finding moderator elections on {network}…
        </p>
      )}
      {ids.status === 'error' && (
        <div className="page-note error" role="alert">
          <p>Could not build the list of elections.</p>
          <TechnicalDetail>{ids.message}</TechnicalDetail>
        </div>
      )}
      {ids.status === 'ok' && <ReadIssues failures={ids.value.failures} caps={ids.value.caps} />}

      {ids.status === 'ok' && (
        <>
          <section className="hub-section">
            <h2 className="section-title">Open now{loading.length === 0 ? ` · ${open.length}` : ''}</h2>
            {open.length > 0 && list(open)}
            {loading.length > 0 && (
              <>
                <p className="meta" role="status">
                  Reading {plural(loading.length, 'election')}…
                </p>
                {list(loading)}
              </>
            )}
            {open.length === 0 && loading.length === 0 && (
              <div className="empty-state">
                <p className="empty-state-title">
                  {failed > 0 ? 'Could not check every election right now.' : `No election is open on ${network} right now.`}
                </p>
                <p>
                  {failed > 0
                    ? `${plural(failed, 'election')} could not be read (listed below), so one may be open. Reload the page to try again.`
                    : decided.length > 0
                    ? `Every seat below is filled, and on protocol 14 a filled seat is permanent. A new election starts when another contract declares elected moderation.`
                    : 'An election starts when a contract declares elected moderation and a team proposes itself.'}
                </p>
              </div>
            )}
          </section>
          {decided.length > 0 && (
            <section className="hub-section">
              <h2 className="section-title">Seats filled · {decided.length}</h2>
              {list(decided)}
            </section>
          )}
          {other.length > 0 && (
            <section className="hub-section">
              <h2 className="section-title">Other contracts · {other.length}</h2>
              {list(other)}
            </section>
          )}
        </>
      )}

      <details className="rules add-contract">
        <summary>Track another contract</summary>
        <p className="meta">
          Paste the id of a contract that declares elected moderation to follow its election here. The list is kept in
          this browser only.
        </p>
        <div className="key-field">
          <input
            className="mono"
            placeholder="Contract id (base58)"
            aria-label="Contract id"
            value={input}
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim()) add();
            }}
          />
          <button className="vote-button ghost" disabled={!input.trim()} onClick={add}>
            Add
          </button>
        </div>
        {addError && <p className="meta error">{addError}</p>}
      </details>
    </div>
  );
}
