import { useEffect, useState } from 'react';
import { getWif, useMasternodes } from '../lib/mn';
import { errorMessage, loadSdk, type Network } from '../lib/sdk';
import {
  castVote,
  loadReceipts,
  recordReceipt,
  type VoteChoice,
} from '../lib/vote';
import { plural, shortId } from '../lib/format';
import { WalletVote } from './WalletVote';
import { ContestedName } from './ContestedName';

type MnStatus =
  | { step: 'queued' }
  | { step: 'signing' }
  | { step: 'accepted' }
  | { step: 'failed'; error: string };

function choiceLabel(choice: VoteChoice): string {
  switch (choice.type) {
    case 'identity':
      return `Vote for ${shortId(choice.identityId, 6)}`;
    case 'abstain':
      return 'Vote abstain';
    case 'lock':
      return 'Vote lock';
  }
}

export function VoteModal({
  network,
  label,
  choice,
  onClose,
  onOpenMasternodes,
}: {
  network: Network;
  label: string;
  choice: VoteChoice;
  onClose: () => void;
  onOpenMasternodes: () => void;
}) {
  const [mode, setMode] = useState<'wallet' | 'key'>('wallet');
  const masternodes = useMasternodes();
  const ready = masternodes.filter((mn) => mn.hasKey);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(ready.map((mn) => mn.id)),
  );
  const [phase, setPhase] = useState<'pick' | 'run' | 'done'>('pick');
  const [statuses, setStatuses] = useState<Record<string, MnStatus>>({});
  const receipts = loadReceipts(network)[label] ?? {};

  const openMasternodes = () => {
    onClose();
    onOpenMasternodes();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'run') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const broadcast = async () => {
    const chosen = ready.filter((mn) => selected.has(mn.id));
    setPhase('run');
    setStatuses(Object.fromEntries(chosen.map((mn) => [mn.id, { step: 'queued' }])));
    const handle = await loadSdk(network);
    // Sequential on purpose: one clear signing status at a time, and no
    // burst of simultaneous state transitions from a single browser.
    for (const mn of chosen) {
      setStatuses((prev) => ({ ...prev, [mn.id]: { step: 'signing' } }));
      const wif = getWif(mn.id);
      if (!wif) {
        setStatuses((prev) => ({
          ...prev,
          [mn.id]: { step: 'failed', error: 'Voting key is no longer loaded.' },
        }));
        continue;
      }
      try {
        await castVote(handle, { proTxHash: mn.proTxHash, wif, label, choice });
        recordReceipt(network, label, mn.proTxHash, choice);
        setStatuses((prev) => ({ ...prev, [mn.id]: { step: 'accepted' } }));
      } catch (e) {
        setStatuses((prev) => ({
          ...prev,
          [mn.id]: { step: 'failed', error: errorMessage(e) },
        }));
      }
    }
    setPhase('done');
  };

  return (
    <div className="modal-backdrop" onClick={phase === 'run' ? undefined : onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Cast masternode votes"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">
          {choiceLabel(choice)}
          <span className="modal-context">
            on <ContestedName label={label} />
            <span className="tld">.dash</span> · {network}
          </span>
        </h2>

        {phase === 'pick' && <div className="discussion-actions signing-method" role="group" aria-label="Signing method">
          <button className="vote-button ghost" aria-pressed={mode === 'wallet'} onClick={() => setMode('wallet')}>Use wallet</button>
          <button className="vote-button ghost" aria-pressed={mode === 'key'} onClick={() => setMode('key')}>Use voting keys in this tab</button>
        </div>}
        {phase === 'pick' && mode === 'wallet' && <>
          <WalletVote network={network} label={label} choice={choice} />
          <div className="modal-actions"><button className="vote-button ghost" onClick={onClose}>Close</button></div>
        </>}
        {phase === 'pick' && mode === 'key' && (
          <>
            {ready.length === 0 ? (
              <div className="modal-empty">
                <p>No voting keys are loaded in this tab.</p>
                <button className="vote-button" onClick={openMasternodes}>
                  Open Masternodes
                </button>
              </div>
            ) : (
              <>
                <p className="modal-hint">
                  Votes are signed here in your browser and broadcast straight
                  to Platform. Each masternode gets 5 votes per contest — the
                  latest one counts.
                </p>
                <ul className="mn-pick-list">
                  {ready.map((mn) => {
                    const used = receipts[mn.proTxHash]?.length ?? 0;
                    return (
                      <li key={mn.id}>
                        <label className="mn-pick">
                          <input
                            type="checkbox"
                            checked={selected.has(mn.id)}
                            onChange={() => toggle(mn.id)}
                          />
                          <span className="mn-pick-label">{mn.label}</span>
                          <span className="mono-label">{shortId(mn.proTxHash, 6)}</span>
                          {used > 0 && (
                            <span className="mono-label">
                              {plural(used, 'vote')} sent from this browser
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {masternodes.length > ready.length && (
                  <p className="modal-hint">
                    {masternodes.length - ready.length} masternode
                    {masternodes.length - ready.length === 1 ? ' has' : 's have'} no
                    voting key loaded —{' '}
                    <button className="link-button" onClick={openMasternodes}>
                      add keys
                    </button>
                    .
                  </p>
                )}
                <div className="modal-actions">
                  <button className="vote-button ghost" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    className="vote-button"
                    disabled={selected.size === 0}
                    onClick={broadcast}
                  >
                    Sign & broadcast {plural(selected.size, 'vote')}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {(phase === 'run' || phase === 'done') && (
          <>
            <ul className="mn-status-list">
              {ready
                .filter((mn) => statuses[mn.id])
                .map((mn) => {
                  const status = statuses[mn.id];
                  return (
                    <li key={mn.id} className={`mn-status ${status.step}`}>
                      <span className="mn-pick-label">{mn.label}</span>
                      <span className="mono-label">{shortId(mn.proTxHash, 6)}</span>
                      <span className="mn-status-text">
                        {status.step === 'queued' && 'waiting'}
                        {status.step === 'signing' && 'signing & broadcasting…'}
                        {status.step === 'accepted' && 'vote accepted'}
                        {status.step === 'failed' && `failed — ${status.error}`}
                      </span>
                    </li>
                  );
                })}
            </ul>
            {phase === 'done' && (
              <div className="modal-actions">
                <button className="vote-button" onClick={onClose}>
                  Done
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
