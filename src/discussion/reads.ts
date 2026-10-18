import type { EvoSDK } from '@dashevo/evo-sdk';
import { idFromValue } from '../charters/documents';
import type { PollKey } from '../model/pollKey';
import { freeQuietly } from '../sdk/free';
import { scopeOf, type Scope } from './scope';

export const COMMENT_TYPE = 'comment';
const PAGE_SIZE = 30;

export interface Comment {
  id: string;
  ownerId: string;
  /** The canonical key of the contest it belongs to. */
  pollKey: string;
  body: string;
  createdAtMs: number;
  /** The comment this answers. */
  replyTo?: string;
  /** The contender identity the author backs. */
  supports?: string;
}

export type CommentOrder = 'newest' | 'oldest';

interface PageOptions {
  order?: CommentOrder;
  startAfter?: string;
  pageSize?: number;
}

export interface CommentPage {
  comments: Comment[];
  /** A full page came back, so there may be more. */
  hasMore: boolean;
  /** Pass as `startAfter` for the next page (the last document read). */
  cursor?: string;
  /** Documents read but not shown: malformed, or naming another contest. */
  hidden: number;
}

/**
 * A comment from a document of the contract. Undefined when it is malformed
 * or, with `expectedPollKey`, when its readable `pollKey` differs (the index
 * said it belongs to this contest, its own text must agree).
 */
export function readComment(
  doc: { id: { toBase58(): string }; ownerId: { toBase58(): string }; createdAt?: bigint | number; properties: Record<string, unknown> },
  expectedPollKey?: string,
): Comment | undefined {
  const p = doc.properties;
  if (typeof p.body !== 'string' || typeof p.pollKey !== 'string') return undefined;
  if (expectedPollKey !== undefined && p.pollKey !== expectedPollKey) return undefined;
  const createdAt = Number(doc.createdAt ?? 0);
  const replyTo = p.replyTo == null ? undefined : idFromValue(p.replyTo);
  const supports = p.supports == null ? undefined : idFromValue(p.supports);
  // A present but unreadable id means a malformed document, not "no reply".
  if ((p.replyTo != null && !replyTo) || (p.supports != null && !supports)) return undefined;
  return {
    id: doc.id.toBase58(),
    ownerId: doc.ownerId.toBase58(),
    pollKey: p.pollKey,
    body: p.body,
    createdAtMs: Number.isFinite(createdAt) ? createdAt : 0,
    ...(replyTo ? { replyTo } : {}),
    ...(supports ? { supports } : {}),
  };
}

/** One page of a contest's comments, by `$createdAt`, paged with `startAfter`. */
export async function fetchComments(
  sdk: EvoSDK,
  contractId: string,
  key: PollKey,
  opts: PageOptions = {},
): Promise<CommentPage> {
  const scope = await scopeOf(key);
  return fetchCommentsByScope(sdk, contractId, scope, opts);
}

/** Further pages read when a page shows nothing (all its documents hidden). */
const MAX_EMPTY_PAGE_SKIPS = 3;

export async function fetchCommentsByScope(
  sdk: EvoSDK,
  contractId: string,
  scope: Scope,
  opts: PageOptions = {},
): Promise<CommentPage> {
  const limit = opts.pageSize ?? PAGE_SIZE;
  let startAfter = opts.startAfter;
  let hidden = 0;
  for (let skips = 0; ; skips++) {
    const page = await sdk.documents.query({
      dataContractId: contractId,
      documentTypeName: COMMENT_TYPE,
      where: [['scope', '==', scope.scope]],
      orderBy: [
        ['scope', 'asc'],
        ['$createdAt', opts.order === 'oldest' ? 'asc' : 'desc'],
      ],
      limit,
      ...(startAfter ? { startAfter } : {}),
    });
    const comments: Comment[] = [];
    let read = 0;
    let cursor: string | undefined;
    for (const doc of page.values()) {
      if (!doc) continue;
      read++;
      try {
        cursor = doc.id.toBase58();
        const comment = readComment(doc, scope.pollKey);
        if (comment) comments.push(comment);
        else hidden++;
      } finally {
        freeQuietly(doc);
      }
    }
    const hasMore = read >= limit;
    // A page of only hidden documents would read as "no comments" next to a
    // "load more": keep going (a few pages) until something is shown.
    if (comments.length === 0 && hasMore && cursor && skips < MAX_EMPTY_PAGE_SKIPS) {
      startAfter = cursor;
      continue;
    }
    return { comments, hasMore, cursor, hidden };
  }
}

/** A comment by id, or undefined when absent. */
export async function fetchComment(
  sdk: EvoSDK,
  contractId: string,
  id: string,
  expectedPollKey: string,
): Promise<Comment | undefined> {
  const doc = await sdk.documents.get(contractId, COMMENT_TYPE, id);
  if (!doc) return undefined;
  try {
    return readComment(doc, expectedPollKey);
  } finally {
    freeQuietly(doc);
  }
}

/** An author's latest comments (the `author` index), newest first. */
export async function fetchLatestByAuthor(
  sdk: EvoSDK,
  contractId: string,
  authorId: string,
  limit = 10,
): Promise<Comment[]> {
  const page = await sdk.documents.query({
    dataContractId: contractId,
    documentTypeName: COMMENT_TYPE,
    where: [['$ownerId', '==', authorId]],
    orderBy: [
      ['$ownerId', 'asc'],
      ['$createdAt', 'desc'],
    ],
    limit,
  });
  const out: Comment[] = [];
  for (const doc of page.values()) {
    if (!doc) continue;
    try {
      const comment = readComment(doc);
      if (comment) out.push(comment);
    } finally {
      freeQuietly(doc);
    }
  }
  return out;
}
