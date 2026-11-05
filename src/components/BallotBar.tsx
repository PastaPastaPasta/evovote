import type { ContestState } from '../lib/dpns';

const CONTENDER_COLORS = [1, 2, 3, 4, 5].map(n => `var(--dh-ramp-${n})`);
export const ABSTAIN_COLOR = 'var(--dh-line-2)';
export const LOCK_COLOR = 'var(--dh-ink-2)';

export function contenderColor(rank: number): string {
  return CONTENDER_COLORS[Math.min(rank, CONTENDER_COLORS.length - 1)];
}

/**
 * The ballot bar: one segment per contender (ranked by tally), then abstain,
 * then lock (hatched). Segment width is the share of all votes cast.
 */
export function BallotBar({
  state,
  mini = false,
}: {
  state: ContestState;
  mini?: boolean;
}) {
  const total = state.totalVotes;
  const segments: { key: string; share: number; color: string; hatched?: boolean; title: string }[] = [];
  if (total > 0) {
    state.contenders.forEach((c, rank) => {
      if (c.votes > 0) {
        segments.push({
          key: c.identityId,
          share: c.votes / total,
          color: contenderColor(rank),
          title: `${c.identityId}: ${c.votes}`,
        });
      }
    });
    if (state.abstain > 0) {
      segments.push({
        key: 'abstain',
        share: state.abstain / total,
        color: ABSTAIN_COLOR,
        title: `Abstain: ${state.abstain}`,
      });
    }
    if (state.lock > 0) {
      segments.push({
        key: 'lock',
        share: state.lock / total,
        color: LOCK_COLOR,
        hatched: true,
        title: `Lock: ${state.lock}`,
      });
    }
  }

  return (
    <div
      className={mini ? 'ballot-bar mini' : 'ballot-bar'}
      role="img"
      aria-label={
        total === 0
          ? 'No votes cast yet'
          : `${total} votes: ` + segments.map((s) => s.title).join(', ')
      }
    >
      {segments.length === 0 ? (
        <div className="ballot-empty">no votes yet</div>
      ) : (
        segments.map((s) => (
          <div
            key={s.key}
            className={s.hatched ? 'ballot-seg hatched' : 'ballot-seg'}
            style={{ width: `${s.share * 100}%`, backgroundColor: s.color }}
            title={s.title}
          />
        ))
      )}
    </div>
  );
}
