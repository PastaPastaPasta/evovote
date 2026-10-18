import type { RawVoteState } from '../../discovery/voteState';

/**
 * DPNS vote states recorded from testnet with @dashevo/evo-sdk 5.0.0-rc.4
 * (contestedResourceVoteState, documentsAndVoteTally, 2026-10-17). Decided
 * contests no longer carry contender documents. `active` is synthetic: a
 * live contest whose contenders carry decoded documents.
 */
export const DPNS_FIXTURES: Record<string, RawVoteState> = {
  '0range': {
    contenders: [{ identityId: 'HEAmUtC72dPcZ59yyLUgfS8pfrEWqzYfDPzTofgWxXRr', voteTally: 8 }],
    abstainVoteTally: 0,
    lockVoteTally: 0,
    winner: {
      kind: 'WonByIdentity',
      identityId: 'HEAmUtC72dPcZ59yyLUgfS8pfrEWqzYfDPzTofgWxXRr',
      block: { timeMs: 1763135862066n },
    },
  },
  '10stest': {
    contenders: [{ identityId: 'AyePjKk57CYHuC2Siv7jsfAPJhPD7nhed95XnMSjxd5t', voteTally: 0 }],
    abstainVoteTally: 0,
    lockVoteTally: 1,
    winner: { kind: 'Locked', block: { timeMs: 1789729235198n } },
  },
  '01eg': {
    contenders: [
      { identityId: '7gKB55Z2XpHcCCiRWgvz8gFhKF4LnrhL7SQCQHbYN39D', voteTally: 0 },
      { identityId: '9fTP7cuhm2yTG7mkNJrmDcJTe81dWEHQuQdknMUMnw9b', voteTally: 0 },
    ],
    abstainVoteTally: 0,
    lockVoteTally: 0,
    winner: {
      kind: 'WonByIdentity',
      identityId: '9fTP7cuhm2yTG7mkNJrmDcJTe81dWEHQuQdknMUMnw9b',
      block: { timeMs: 1768405090203n },
    },
  },
  '001': {
    contenders: [{ identityId: '8xHtuybCkJZv4gnxfRz7w6MdxnR3a5sntctruXxdvAuY', voteTally: 0 }],
    abstainVoteTally: 4,
    lockVoteTally: 0,
    winner: {
      kind: 'WonByIdentity',
      identityId: '8xHtuybCkJZv4gnxfRz7w6MdxnR3a5sntctruXxdvAuY',
      block: { timeMs: 1730367626350n },
    },
  },
  active: {
    contenders: [
      {
        identityId: '7gKB55Z2XpHcCCiRWgvz8gFhKF4LnrhL7SQCQHbYN39D',
        voteTally: 2,
        serializedDocument: Uint8Array.from([1]),
      },
      {
        identityId: '9fTP7cuhm2yTG7mkNJrmDcJTe81dWEHQuQdknMUMnw9b',
        voteTally: 5,
        serializedDocument: Uint8Array.from([2]),
      },
    ],
    abstainVoteTally: 1,
    lockVoteTally: 3,
  },
};

/** Stand-in for Document.fromBytes(...).toJSON(): byte 1 and 2 → two spellings. */
export function decodeFixtureDocument(bytes: Uint8Array): Record<string, unknown> {
  return { $type: 'domain', label: bytes[0] === 2 ? 'TheRoadNotTaken' : 'theroadnottaken', normalizedLabel: 'ther0adn0ttaken' };
}
