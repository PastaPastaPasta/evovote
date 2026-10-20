import { useEffect, useMemo, useState } from 'react';
import { forEachConcurrent } from '../../discovery/concurrency';
import { invalidateContest } from '../../discovery/voteState';
import { kindFor } from '../../kinds/registry';
import { isVotable, type Contest, type VoteChoice } from '../../model/contest';
import { loadSdk } from '../../sdk/connection';
import { errorMessage } from '../../sdk/errors';
import type { Network } from '../../sdk/network';
import { MAX_PARALLEL_MASTERNODES, runBroadcast, type BroadcastJob, type JobStatus } from '../../voting/broadcaster';
import { castVote, verifyVote } from '../../voting/cast';
import { readCurrentVotes } from '../../voting/currentVotes';
import { getLoadedKey, useMasternodes } from '../../voting/keyring';
import { planVotes, SKIP_TEXT, VOTES_PER_POLL, type PlanItem } from '../../voting/planner';
import { receiptsFor, recordReceipt } from '../../voting/receipts';
import { shortId, plural } from '../format';
import { KindTitle } from './KindTitle';
import { TechnicalDetail } from './TechnicalDetail';

/** How a masternode's current vote reads in the list ("Abstain", "alice", "Has not voted"). Pure. */
export function currentVoteText(
  vote: VoteChoice | undefined,
  name: (identityId: string) => string,
): string {
  if (!vote) return 'Has not voted yet';
  switch (vote.type) {
    case 'identity':
      return `Votes for ${name(vote.identityId)}`;
    case 'abstain':
      return 'Votes abstain';
    case 'lock':
      return 'Votes lock';
  }
}

/** The dialog's heading: what this vote does, in words. Pure. */
export function choiceHeading(choice: VoteChoice, choiceName?: string): string {
  switch (choice.type) {
    case 'identity':
      return `Vote for ${choiceName ?? shortId(choice.identityId)}`;
    case 'abstain':
      return 'Vote abstain';
    case 'lock':
      return 'Vote lock: award it to no one';
  }
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
  names,
  onClose,
  onOpenMasternodes,
}: {
  network: Network;
  contest: Contest;
  choice: VoteChoice;
  /** The contenders' names (as the page shows them), by identity id. */
  names?: ReadonlyMap<string, string>;
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
  const name = (identityId: string) => names?.get(identityId) ?? shortId(identityId);
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
        await castVote(handle, {
          proTxHash: item.proTxHash,
          key,
          pollKey: contest.key,
          keyString: contest.keyString,
          choice,
        });
        // Receipts are recorded only for votes that went through: the budget
        // is a lower bound and must never overcount (an ambiguous failure
        // that did land shows up as the node's current vote instead).
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
        aria-labelledby="vote-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title" id="vote-modal-title">
          {choiceHeading(choice, choice.type === 'identity' ? names?.get(choice.identityId) : undefined)}
          <span className="modal-context">
            <KindTitle contest={contest} tld /> · {network === 'testnet' ? 'Testnet' : 'Mainnet'}
          </span>
        </h2>

        {phase === 'pick' && ready.length === 0 && (
          <div className="modal-empty">
            <p>
              <strong>Add your masternode&apos;s voting key to vote.</strong>
            </p>
            <p className="modal-hint">
              The key stays in this tab and is forgotten when you close it. It can only vote; it cannot move funds.
            </p>
            <div className="modal-actions">
              <button className="vote-button ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="vote-button" onClick={openMasternodes}>
                Add a voting key
              </button>
            </div>
          </div>
        )}

        {phase === 'pick' && ready.length > 0 && (
          <>
            <ul className="modal-facts">
              <li>
                <strong>Weight.</strong> A regular masternode&apos;s vote counts 1; an evonode&apos;s counts 4.
              </li>
              <li>
                <strong>You can change it.</strong> Each masternode can vote {VOTES_PER_POLL} times on this
                contest while voting is open; only its latest vote counts.
              </li>
              <li>
                <strong>Public, then final.</strong> Votes are signed in this browser and sent straight to Dash
                Platform, where anyone can see them. When voting closes, the result is permanent.
              </li>
            </ul>
            {current === 'loading' && (
              <p className="modal-hint" role="status">
                Checking how each masternode votes now…
              </p>
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
                      <span className="mono-label mono" title={mn.proTxHash}>
                        {shortId(mn.proTxHash)}
                      </span>
                      {current !== 'loading' && (
                        <span className="mono-label">
                          {votes === undefined
                            ? "Couldn't check its current vote"
                            : currentVoteText(votes.get(contest.keyString), name)}
                        </span>
                      )}
                      {item && item.votesUsedAtLeast > 0 && (
                        <span className="mono-label">
                          {item.votesUsedAtLeast >= VOTES_PER_POLL
                            ? `All ${VOTES_PER_POLL} votes used`
                            : `At least ${item.votesUsedAtLeast} of its ${VOTES_PER_POLL} votes used`}
                        </span>
                      )}
                      {item?.action === 'skip' && item.reason && item.reason !== 'budget' && (
                        <span className="mono-label plan-skip">Skipped: {SKIP_TEXT[item.reason]}</span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
            {masternodes.length > ready.length && (
              <p className="modal-hint">
                {plural(masternodes.length - ready.length, 'more masternode')} without a voting key loaded.{' '}
                <button className="link-button" onClick={openMasternodes}>
                  Add their keys
                </button>
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
                {toCast.length === 0 ? 'Nothing to send' : `Sign and send ${plural(toCast.length, 'vote')}`}
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
                      <span className="mono-label mono">{shortId(mn.proTxHash)}</span>
                      <span className="mn-status-text">
                        {status.step === 'queued' && 'Waiting…'}
                        {status.step === 'sending' && 'Signing and sending…'}
                        {status.step === 'accepted' && 'Vote recorded'}
                        {status.step === 'unverified' && 'Sent. Platform has not shown it yet; close this and check the standings again in a minute.'}
                        {status.step === 'failed' && (
                          <>
                            Not recorded: {status.error.message}
                            {status.error.detail !== status.error.message && (
                              <TechnicalDetail>{status.error.detail}</TechnicalDetail>
                            )}
                          </>
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
