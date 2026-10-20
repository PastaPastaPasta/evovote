import { describe, expect, it } from 'vitest';
import { base58Encode } from '../model/bytes';
import { buildThreads, commentLink, initialOf, isBusyError, linkedCommentId, relativeTime } from './present';
import type { Comment } from './reads';

const id32 = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const c = (n: number, over: Partial<Comment> = {}): Comment => ({
  id: id32(n),
  ownerId: id32(200),
  pollKey: 'k',
  body: `c${n}`,
  createdAtMs: 1_000 + n,
  ...over,
});

describe('buildThreads', () => {
  it('should nest replies one level under their root, oldest first', () => {
    const root = c(1);
    const reply = c(3, { replyTo: root.id });
    const replyToReply = c(2, { replyTo: reply.id, createdAtMs: 5_000 });
    const other = c(4);
    const threads = buildThreads([other, replyToReply, reply, root]);
    expect(threads.map((t) => t.root.id)).toEqual([other.id, root.id]);
    expect(threads[1].replies.map((r) => r.id)).toEqual([reply.id, replyToReply.id]);
    expect(threads.every((t) => !t.orphan)).toBe(true);
  });

  it('should show a reply whose parent is not loaded as an orphan root', () => {
    const threads = buildThreads([c(1, { replyTo: id32(99) })]);
    expect(threads).toHaveLength(1);
    expect(threads[0].orphan).toBe(true);
  });

  it('should survive a reply cycle', () => {
    const a = c(1, { replyTo: id32(2) });
    const b = c(2, { replyTo: id32(1) });
    const threads = buildThreads([a, b]);
    expect(threads.flatMap((t) => [t.root, ...t.replies])).toHaveLength(2);
  });
});

describe('presentation helpers', () => {
  const now = Date.UTC(2026, 9, 20, 12);
  it('should word times relative to now', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 days ago');
    expect(relativeTime(now - 30 * 86_400_000, now)).not.toMatch(/ago/);
  });

  it('should tell a busy node from other failures', () => {
    expect(isBusyError('status: ResourceExhausted, message: "rate limited"')).toBe(true);
    expect(isBusyError('Too Many Requests')).toBe(true);
    expect(isBusyError('document not found')).toBe(false);
  });

  it('should take the first letter or digit for an avatar', () => {
    expect(initialOf('alice.dash')).toBe('A');
    expect(initialOf('_9x')).toBe('9');
    expect(initialOf('')).toBe('?');
  });

  it('should read and build comment links around the hash route', () => {
    const id = id32(5);
    expect(linkedCommentId(`?c=${id}`)).toBe(id);
    expect(linkedCommentId('?c=not-an-id')).toBeUndefined();
    expect(linkedCommentId('')).toBeUndefined();
    expect(commentLink({ origin: 'https://x.io', pathname: '/app/', hash: '#/p/abc' }, id)).toBe(`https://x.io/app/?c=${id}#/p/abc`);
  });
});
