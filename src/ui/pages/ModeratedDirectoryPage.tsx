import { useEffect, useState } from 'react';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { knownContractById } from '../../config/knownContracts';
import { durationText, INTERIM_TEXT } from '../../charters/declaration';
import {
  addContract,
  collectDirectoryIds,
  fetchDirectoryEntry,
  removeContract,
  useAddedContracts,
  type DirectoryEntryState,
  type DirectorySource,
} from '../../charters/directory';
import { moderatedHref } from '../../charters/pollKey';
import { forEachConcurrent } from '../../discovery/concurrency';
import type { Network } from '../../sdk/network';
import { ReadIssues } from '../components/ReadIssues';
import { shortId } from '../format';
import { useAsync } from '../useAsync';

const SOURCE_TEXT: Record<DirectorySource, string> = {
  known: 'listed',
  contested: 'contested',
  added: 'added by you',
};

function EntryStatus({ state }: { state: DirectoryEntryState | undefined }) {
  if (!state) return <span className="mono-label">…</span>;
  if (state.found === false) return <span className="mono-label error">no such contract on this network</span>;
  if (!state.moderation) return <span className="mono-label error">could not be read</span>;
  const d = state.moderation.declaration;
  if (d.kind !== 'elected') return <span className="mono-label">not elected ({d.kind})</span>;
  const e = d.elected;
  return (
    <span className="mono-label">
      {state.team ? 'team seated' : state.failures.some((f) => f.source === 'the seated team') ? 'seat unknown' : 'seat open'} · join{' '}
      {durationText(e.joinWindowSeconds)} · vote {durationText(e.voteWindowSeconds)} · {INTERIM_TEXT[e.interim.kind]}
    </span>
  );
}

/** `#/m`: every contract with a moderator election this site knows of. */
export function ModeratedDirectoryPage({ sdk, network }: { sdk: EvoSDK; network: Network }) {
  const added = useAddedContracts(network);
  const ids = useAsync(() => collectDirectoryIds(sdk, network), [sdk, network, added]);
  const [states, setStates] = useState<Record<string, DirectoryEntryState>>({});
  const [input, setInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const entries = ids.status === 'ok' ? ids.value.entries : [];
  useEffect(() => {
    let cancelled = false;
    void forEachConcurrent(entries, 4, async ({ id }) => {
      const state = await fetchDirectoryEntry(sdk, id);
      if (!cancelled) setStates((prev) => ({ ...prev, [id]: state }));
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

  return (
    <div className="contest-list">
      <h1 className="section-title">Moderated contracts</h1>
      <p className="fine-print">
        Contracts that declare elected moderation let masternodes elect their moderation team. This list joins
        the contracts EvoVote knows, every contract whose seat was ever contested on {network}, and the ones you
        add.
      </p>
      {ids.status === 'loading' && <p className="page-note">Reading contested moderation seats…</p>}
      {ids.status === 'error' && <p className="page-note error">Could not build the list: {ids.message}</p>}
      {ids.status === 'ok' && <ReadIssues failures={ids.value.failures} caps={ids.value.caps} />}
      {ids.status === 'ok' && entries.length === 0 && (
        <p className="page-note">
          {ids.value.failures.length > 0
            ? 'None found, but some reads failed (see above).'
            : `No contract has had a moderator election on ${network} yet, and none is listed. Add a contract id below.`}
        </p>
      )}
      <ol className="ledger">
        {entries.map(({ id, sources }) => (
          <li key={id}>
            <div className="ledger-row directory-row">
              <a className="ledger-name" href={moderatedHref(id)}>
                {knownContractById(id)?.name ?? <span className="mono">{shortId(id, 8)}</span>}
              </a>
              <EntryStatus state={states[id]} />
              <span className="mono-label">{sources.map((s) => SOURCE_TEXT[s]).join(' · ')}</span>
              {sources.includes('added') && (
                <button className="link-button" onClick={() => removeContract(network, id)} aria-label={`Remove ${id}`}>
                  remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <h2 className="section-title">Add a contract</h2>
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
      {addError && <p className="mono-label error">{addError}</p>}
      <p className="fine-print">Added contracts are remembered in this browser only.</p>
    </div>
  );
}
