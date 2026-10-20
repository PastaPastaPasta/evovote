import type { Tally } from '../../model/contest';

// The leader is Dash blue; the first challenger gets a clearly different hue
// (teal) so a real fight is visible at a glance, not a blue-on-blue guess.
const CONTENDER_COLORS = [
  '#008DE4',
  '#0FA88F',
  '#7CC4EF',
  '#67D4C0',
  '#C2E3F9',
];
export const ABSTAIN_COLOR = '#9DB0BE';
export const LOCK_COLOR = '#B3362B';

export function contenderColor(rank: number): string {
  return CONTENDER_COLORS[Math.min(rank, CONTENDER_COLORS.length - 1)];
}

/**
 * The ballot bar: one segment per contender (ranked by tally), then abstain,
 * then lock (hatched). Segment width is the share of all votes cast. With no
 * votes the full bar says so; the mini bar stays an empty track (the row's
 * vote count says it, and text does not fit in 10 px).
 */
export function BallotBar({
  state,
  mini = false,
  showLock = true,
  ended = false,
}: {
  state: Tally;
  mini?: boolean;
  /** False for resolution-1 contests, which have no Lock. */
  showLock?: boolean;
  /** The contest is over: "no votes cast", never "no votes yet". */
  ended?: boolean;
}) {
  const none = ended ? 'No votes cast' : 'No votes cast yet';
  const total = state.total;
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
    if (showLock && state.lock > 0) {
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
        total === 0 ? none : `${total} votes: ` + segments.map((s) => s.title).join(', ')
      }
    >
      {segments.length === 0 ? (
        !mini && <div className="ballot-empty">{none.toLowerCase()}</div>
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
