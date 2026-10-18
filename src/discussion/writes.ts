import { estimateDocumentCreate, type FieldSize, type WriteCost } from '../charters/writes';
import { settleWrite, type SettleOptions, type WriteOutcome } from '../identity/outcome';
import type { DocumentSigner } from '../identity/session';
import { base58Decode, base58Encode, isBase58Identifier, utf8Length } from '../model/bytes';
import type { PollKey } from '../model/pollKey';
import type { SdkHandle } from '../sdk/connection';
import { freeQuietly } from '../sdk/free';
import { COMMENT_TYPE, fetchComment, type Comment } from './reads';
import { scopeOf, type Scope } from './scope';

/** The schema's bound on a comment (contracts/discussion.json). */
export const COMMENT_LIMIT = 2000;

type SdkModule = SdkHandle['mod'];
type WasmDocument = InstanceType<SdkModule['Document']>;

export interface CommentDraft {
  body: string;
  /** The comment this answers (must belong to the same contest). */
  replyTo?: string;
  /** The contender identity the author backs. */
  supports?: string;
}

/** Characters (code points), the unit the contract's `maxLength` counts. */
export const commentLength = (body: string): number => Array.from(body.trim()).length;

/** Why a draft cannot be posted, or an empty list. */
export function validateDraft(draft: CommentDraft): string[] {
  const problems: string[] = [];
  const length = commentLength(draft.body);
  if (length === 0) problems.push('Write something first.');
  if (length > COMMENT_LIMIT) problems.push(`A comment holds at most ${COMMENT_LIMIT} characters (this has ${length}).`);
  if (draft.replyTo !== undefined && !isBase58Identifier(draft.replyTo)) problems.push('The comment replied to is not a valid id.');
  if (draft.supports !== undefined && !isBase58Identifier(draft.supports)) problems.push('The supported contender is not a valid id.');
  return problems;
}

/** The document's properties; throws on an invalid draft. */
export function commentProperties(scope: Scope, draft: CommentDraft): Record<string, unknown> {
  const problems = validateDraft(draft);
  if (problems.length > 0) throw new Error(problems.join(' '));
  return {
    scope: scope.scope,
    pollKey: scope.pollKey,
    body: draft.body.trim(),
    ...(draft.replyTo ? { replyTo: base58Decode(draft.replyTo) } : {}),
    ...(draft.supports ? { supports: base58Decode(draft.supports) } : {}),
  };
}

/**
 * A new comment document. Built with `Document.fromObject` so the identifier
 * properties stay bytes (the constructor would turn them into arrays of
 * numbers). The id is a placeholder: `documents.create` derives the real one.
 * `$createdAt` is required by the schema.
 */
export function newCommentDocument(
  mod: SdkModule,
  contractId: string,
  ownerId: string,
  properties: Record<string, unknown>,
  now = Date.now(),
): WasmDocument {
  const object = {
    $formatVersion: '0',
    $id: new Uint8Array(32),
    $ownerId: base58Decode(ownerId),
    $dataContractId: base58Decode(contractId),
    $type: COMMENT_TYPE,
    $entropy: crypto.getRandomValues(new Uint8Array(32)),
    $createdAt: BigInt(now),
    ...properties,
  };
  return mod.Document.fromObject(object as unknown as Parameters<SdkModule['Document']['fromObject']>[0], mod.PlatformVersion.latest());
}

/** The estimated cost of posting this draft, from Drive's own estimator. */
export function estimateComment(
  handle: SdkHandle,
  contractId: string,
  scope: Scope,
  draft: CommentDraft,
): Promise<WriteCost> {
  const sizes: Record<string, FieldSize> = {
    scope: scope.scope.length,
    pollKey: utf8Length(scope.pollKey),
    body: utf8Length(draft.body.trim()),
  };
  if (!draft.replyTo) sizes.replyTo = 'absent';
  if (!draft.supports) sizes.supports = 'absent';
  return estimateDocumentCreate(handle, contractId, COMMENT_TYPE, sizes);
}

/** Whether a comment read back is the one that was written. */
function sameComment(read: Comment, wrote: { ownerId: string; scope: Scope; draft: CommentDraft }): boolean {
  return (
    read.ownerId === wrote.ownerId &&
    read.pollKey === wrote.scope.pollKey &&
    read.body === wrote.draft.body.trim() &&
    read.replyTo === wrote.draft.replyTo &&
    read.supports === wrote.draft.supports
  );
}

/**
 * The id `documents.create` will give a comment: from protocol version 14 it
 * commits to the identity's next contract nonce. Undefined when the nonce
 * cannot be read (the create's own answer is then the only id).
 */
async function expectedCommentId(
  handle: SdkHandle,
  contractId: string,
  ownerId: string,
  doc: WasmDocument,
): Promise<string | undefined> {
  try {
    const nonce = await handle.sdk.identities.contractNonce(ownerId, contractId);
    const id = handle.mod.Document.generateId(COMMENT_TYPE, ownerId, contractId, doc.entropy, (nonce ?? 0n) + 1n);
    return base58Encode(id);
  } catch {
    return undefined;
  }
}

/**
 * Post a comment and confirm it by reading it back (design §4.5/§4.6). A
 * reply must answer a comment of the same contest. Returns the comment as
 * Platform has it.
 *
 * The read-back is of one exact id: the one `create` returned, or, when the
 * create gave no answer (a timeout), the id derived from the nonce read
 * before signing. It never scans the author's comments for a look-alike, so
 * an earlier identical comment cannot be mistaken for this one; an unanswered
 * create that cannot be found is reported as such, not as posted.
 */
export async function postComment(
  handle: SdkHandle,
  signer: DocumentSigner,
  contractId: string,
  key: PollKey,
  draft: CommentDraft,
  settle?: SettleOptions,
): Promise<WriteOutcome<Comment>> {
  const { sdk } = handle;
  const scope = await scopeOf(key);
  const properties = commentProperties(scope, draft);
  const wrote = { ownerId: signer.identityId, scope, draft };
  if (draft.replyTo) {
    const parent = await fetchComment(sdk, contractId, draft.replyTo, scope.pollKey);
    if (!parent) throw new Error('The comment you are replying to is not in this discussion.');
  }
  const doc = newCommentDocument(handle.mod, contractId, signer.identityId, properties);
  try {
    const expectedId = await expectedCommentId(handle, contractId, signer.identityId, doc);
    return await settleWrite<string, Comment>(
      async () => {
        const created = await sdk.documents.create({ document: doc, identityKey: signer.identityKey, signer: signer.signer });
        try {
          return created.id.toBase58();
        } finally {
          freeQuietly(created);
        }
      },
      async (id) => {
        const wanted = id ?? expectedId;
        if (!wanted) return undefined;
        const read = await fetchComment(sdk, contractId, wanted, scope.pollKey);
        return read && sameComment(read, wrote) ? read : undefined;
      },
      settle,
    );
  } finally {
    freeQuietly(doc);
  }
}
