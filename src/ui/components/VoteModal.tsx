import { useEffect, useMemo, useState } from 'react';
import { forEachConcurrent } from '../../discovery/concurrency';
import { invalidateContest } from '../../discovery/voteState';
import { kindFor } from '../../kinds/registry';
import { isVotable, type Contest, type VoteChoice } from '../../model/contest';
import { loadSdk } from '../../sdk/connection';
import { errorCode, errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { MAX_PARALLEL_MASTERNODES, runBroadcast, type BroadcastJob, type JobStatus } from '../../voting/broadcaster';
import { castVote, NotBroadcastError, verifyVote } from '../../voting/cast';
import { readCurrentVotes } from '../../voting/currentVotes';
import { getLoadedKey, useMasternodes } from '../../voting/keyring';
import { planVotes, SKIP_TEXT, VOTES_PER_POLL, type PlanItem } from '../../voting/planner';
import { receiptsFor, recordReceipt } from '../../voting/receipts';
import { shortId, plural } from '../format';
import { KindTitle } from './KindTitle';

function choiceText(choice: VoteChoice | undefined): string {
  if (!choice) return 'none';
  switch (choice.type) {
    case 'identity':
      return shortId(choice.identityId, 6);
    case 'abstain':
      return 'abstain';
    case 'lock':
      return 'lock';
  }
}

function choiceLabel(choice: VoteChoice): string {
  return choice.type === 'identity'
    ? `Vote for ${shortId(choice.identityId, 6)}`
    : choice.type === 'abstain'
      ? 'Vote abstain'
      : 'Vote lock';
}

type CurrentVotes = Map<string, Map<string, VoteChoice> | undefined>;

/**
 * Plan, sign and broadcast one choice on one contest from the selected
 * masternodes. Each node's current vote is read first, so no-op re-votes
 * (40304) and spent budgets are skipped before anything is signed.
 */
export function VoteModal({
  network,
  contest,
  choice,
  onClose,
  onOpenMasternodes,
}: {
  network: Network;
  contest: Contest;
  choice: VoteChoice;
  onClose: () => void;
  onOpenMasternodes: () => void;
}) {
  const masternodes = useMasternodes();
  const ready = useMemo(() => masternodes.filter((mn) => mn.hasKey), [masternodes]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ready.map((mn) => mn.id)));
  const [current, setCurrent] = useState<CurrentVotes | 'loading'>('loading');
  const [phase, setPhase] = useState<'pick' | 'run' | 'done'>('pick');
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({});
  const kind = kindFor(contest.key);

  // Read every ready node's current votes (bounded concurrency).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { sdk } = await loadSdk(network);
      const out: CurrentVotes = new Map();
      await forEachConcurrent(ready, MAX_PARALLEL_MASTERNODES, async (mn) => {
        try {
          out.set(mn.id, await readCurrentVotes(sdk, mn.proTxHash));
        } catch {
          out.set(mn.id, undefined);
        }
      });
      if (!cancelled) setCurrent(out);
    })().catch(() => {
      if (!cancelled) setCurrent(new Map());
    });
    return () => {
      cancelled = true;
    };
  }, [network, ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'run') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  const plan: PlanItem[] = useMemo(() => {
    if (current === 'loading') return [];
    return planVotes({
      polls: [
        {
          keyString: contest.keyString,
          allowedChoices: kind.choices(contest),
          contenderIds: contest.tally.contenders.map((c) => c.identityId),
          votable: isVotable(contest),
        },
      ],
      masternodes: ready.filter((mn) => selected.has(mn.id)),
      choice,
      currentVotes: current,
      sentCount: (proTxHash, keyString) => receiptsFor(network, keyString, proTxHash).length,
    });
  }, [current, contest, kind, ready, selected, choice, network]);

  const toCast = plan.filter((item) => item.action === 'cast');
  const planFor = (mnId: string) => plan.find((item) => item.mnId === mnId);

  const openMasternodes = () => {
    onClose();
    onOpenMasternodes();
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const broadcast = async (items: PlanItem[]) => {
    setPhase('run');
    let handle;
    try {
      handle = await loadSdk(network);
    } catch (e) {
      const error = { message: errorMessage(e), detail: errorMessage(e) };
      setStatuses(Object.fromEntries(items.map((i) => [i.mnId, { step: 'failed', error }])));
      setPhase('done');
      return;
    }
    const jobs: BroadcastJob[] = items.map((item) => ({
      id: item.mnId,
      mnId: item.mnId,
      run: async () => {
        const key = getLoadedKey(item.mnId);
        if (!key) throw new Error('The voting key is no longer loaded.');
        try {
          await castVote(handle, {
            proTxHash: item.proTxHash,
            key,
            pollKey: contest.key,
            keyString: contest.keyString,
            choice,
          });
        } catch (e) {
          // No consensus code (a timeout, a dropped connection): the vote may
          // still have landed, so count it against the budget's lower bound.
          if (errorCode(e) === undefined && !(e instanceof NotBroadcastError)) {
            recordReceipt(network, contest.keyString, item.proTxHash, {
              choice,
              at: Date.now(),
              verified: false,
            });
          }
          throw e;
        }
        const verified = await verifyVote(handle, item.proTxHash, contest.keyString, choice);
        recordReceipt(network, contest.keyString, item.proTxHash, {
          choice,
          at: Date.now(),
          verified,
        });
        return verified;
      },
    }));
    await runBroadcast(jobs, (id, status) => setStatuses((prev) => ({ ...prev, [id]: status })));
    invalidateContest(contest.keyString);
    setPhase('done');
  };

  // Refusals that cannot change on a retry are not offered again.
  const final = new Set([40302, 40303, 40304, 40305, 40306, 40307]);
  const failed = plan.filter((item) => {
    const status = statuses[item.mnId];
    return (
      item.action === 'cast' &&
      status?.step === 'failed' &&
      !(status.error.code !== undefined && final.has(status.error.code))
    );
  });

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
            on <KindTitle contest={contest} tld /> · {network}
          </span>
        </h2>

        {phase === 'pick' && ready.length === 0 && (
          <div className="modal-empty">
            <p>No verified voting keys are loaded in this tab.</p>
            <button className="vote-button" onClick={openMasternodes}>
              Open Masternodes
            </button>
          </div>
        )}

        {phase === 'pick' && ready.length > 0 && (
          <>
            <p className="modal-hint">
              Votes are signed here in your browser and broadcast straight to Platform.
              Each masternode has {VOTES_PER_POLL} votes per contest in total, counting the
              first; the latest one counts.
            </p>
            {current === 'loading' && (
              <p className="mono-label">Reading each masternode's current vote…</p>
            )}
            <ul className="mn-pick-list">
              {ready.map((mn) => {
                const item = planFor(mn.id);
                const votes = current === 'loading' ? undefined : current.get(mn.id);
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
                      {current !== 'loading' && (
                        <span className="mono-label">
                          {votes === undefined
                            ? 'current vote unknown (read failed)'
                            : `now: ${choiceText(votes.get(contest.keyString))}`}
                        </span>
                      )}
                      {item && item.votesUsedAtLeast > 0 && (
                        <span className="mono-label">
                          ≥{item.votesUsedAtLeast} of {VOTES_PER_POLL} used
                        </span>
                      )}
                      {item?.action === 'skip' && item.reason && (
                        <span className="mono-label plan-skip">
                          skip: {SKIP_TEXT[item.reason]}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
            {masternodes.length > ready.length && (
              <p className="modal-hint">
                {plural(masternodes.length - ready.length, 'masternode')} without a verified
                key —{' '}
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
                disabled={current === 'loading' || toCast.length === 0}
                onClick={() => void broadcast(toCast)}
              >
                Sign &amp; broadcast {plural(toCast.length, 'vote')}
              </button>
            </div>
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
                        {status.step === 'sending' && 'signing, broadcasting, verifying…'}
                        {status.step === 'accepted' && 'vote recorded (read back from Platform)'}
                        {status.step === 'unverified' &&
                          'broadcast, but not yet visible on Platform — check again shortly'}
                        {status.step === 'failed' && (
                          <span title={status.error.detail}>failed — {status.error.message}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
            </ul>
            {phase === 'done' && (
              <div className="modal-actions">
                {failed.length > 0 && (
                  <button className="vote-button ghost" onClick={() => void broadcast(failed)}>
                    Retry {plural(failed.length, 'failed vote')}
                  </button>
                )}
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
