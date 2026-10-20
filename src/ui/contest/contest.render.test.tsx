import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EvoSDK } from '@dashevo/evo-sdk';
import { dpnsKind, dpnsPollKey } from '../../kinds/dpns';
import { base58Encode } from '../../model/bytes';
import { encodePollKey } from '../../model/pollKey';
import type { Contender, Contest } from '../../model/contest';
import { orderContenders } from '../pages/ContestPage';
import { ContenderCard, percent } from './ContenderCard';

const id32 = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const A = id32(1);
const B = id32(2);
const key = dpnsPollKey('a1ice');

const contest = (contenders: Contender[], winner?: string): Contest => ({
  key,
  keyString: encodePollKey(key),
  tally: { contenders, abstain: 0, lock: 0, total: contenders.reduce((n, c) => n + c.votes, 0) },
  unreadableContenders: 0,
  ...(winner ? { winner: { kind: 'identity', identityId: winner, rawKind: 'WonByIdentity', decidedAtMs: 1 } } : {}),
});

const card = (c: Contest, contender: Contender, extra: { winnerVotes?: number; name?: string } = {}) =>
  renderToStaticMarkup(
    <ol>
      <ContenderCard
        sdk={{} as EvoSDK}
        kind={dpnsKind}
        contest={c}
        contender={contender}
        rank={0}
        name={extra.name}
        otherNames={[]}
        winnerVotes={extra.winnerVotes}
        canVote={false}
        onVote={() => {}}
      />
    </ol>,
  );

describe('contender card', () => {
  it('should offer the voter list only while the contest is undecided', () => {
    const a = { identityId: A, votes: 4 };
    expect(card(contest([a]), a)).toContain('Show voters');
    expect(card(contest([a], A), a)).not.toContain('Show voters');
    // Nobody to list.
    const zero = { identityId: B, votes: 0 };
    expect(card(contest([a, zero]), zero)).not.toContain('Show voters');
  });

  it('should label the tally as weight with its share, and say by how much a loser lost', () => {
    const a = { identityId: A, votes: 12 };
    const b = { identityId: B, votes: 4 };
    const html = card(contest([a, b], A), b, { winnerVotes: 12 });
    expect(html).toContain('weight · 25%');
    expect(html).toContain('Lost 4–12');
    expect(card(contest([a, b], A), a)).toContain('Winner');
  });

  it('should call an equal loser tied, and say nothing of margins when nobody voted', () => {
    const a = { identityId: A, votes: 5 };
    const b = { identityId: B, votes: 5 };
    expect(card(contest([a, b], A), b, { winnerVotes: 5 })).toContain('Tied 5–5');
    const z = { identityId: B, votes: 0 };
    const unvoted = card(contest([{ identityId: A, votes: 0 }, z], A), z, { winnerVotes: 0 });
    expect(unvoted).not.toContain('Lost');
    expect(unvoted).not.toContain('weight ·');
  });

  it('should show one label per person: the name, else a short id', () => {
    const a = { identityId: A, votes: 1 };
    const named = card(contest([a]), a, { name: 'alice.dash' });
    expect(named).toContain('alice.dash');
    // Visible text only: the full id stays in the tooltip and the copy button's label.
    const text = (html: string) => html.replace(/<[^>]*>/g, ' ');
    expect(text(named)).not.toContain(A.slice(0, 6));
    expect(text(card(contest([a]), a)).match(new RegExp(`${A.slice(0, 6)}…`, 'g'))).toHaveLength(1);
  });

  it('should word shares the same way everywhere', () => {
    expect(percent(4, 16)).toBe('25%');
    expect(percent(0, 0)).toBe('0%');
  });
});

describe('orderContenders', () => {
  it('should put the winner first on a tie, else keep weight order', () => {
    const a = { identityId: A, votes: 0 };
    const b = { identityId: B, votes: 0 };
    expect(orderContenders([a, b], B).map((c) => c.identityId)).toEqual([B, A]);
    expect(orderContenders([a, b]).map((c) => c.identityId)).toEqual([A, B]);
    expect(orderContenders([{ ...a, votes: 1 }, { ...b, votes: 3 }], A).map((c) => c.identityId)).toEqual([B, A]);
  });
});
