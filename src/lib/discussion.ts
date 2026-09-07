import type { Document, DocumentObject, StateTransition } from '@dashevo/evo-sdk';
import type { SdkHandle, SdkModule } from './sdk';
import { base58Encode } from './keys';
import { identifierBytes, platformBytes } from './wallet';
import { usableAuthKey, type DiscussionSession } from './discussion-auth';

export const COMMENT_LIMIT = 2000;
export const PAGE_SIZE = 30;
export interface Comment {
  id: string;
  ownerId: string;
  contest: string;
  body: string;
  createdAt: number;
  replyTo?: string;
}

export function commentProperties(contest: string, body: string, replyTo?: string): Record<string, unknown> {
  if (!/^[a-z0-9-]{1,63}$/.test(contest)) throw new Error('Invalid contest name.');
  const clean = body.trim();
  if (!clean || Array.from(clean).length > COMMENT_LIMIT) throw new Error(`Comments must contain 1–${COMMENT_LIMIT} characters.`);
  return { contest, body: clean, ...(replyTo ? { replyTo: identifierBytes(replyTo) } : {}) };
}

function readComment(doc: Document): Comment {
  const properties = doc.properties;
  const replyTo = properties.replyTo;
  return {
    id: doc.id.toString(), ownerId: doc.ownerId.toString(),
    contest: String(properties.contest), body: String(properties.body),
    createdAt: Number(doc.createdAt),
    ...(replyTo ? { replyTo: typeof replyTo === 'string' ? replyTo : base58Encode(platformBytes(replyTo, 32)) } : {}),
  };
}

export async function fetchComments(handle: SdkHandle, contractId: string, contest: string, startAfter?: string) {
  const documents = await handle.sdk.documents.query({
    dataContractId: contractId, documentTypeName: 'comment',
    where: [['contest', '==', contest]],
    orderBy: [['contest', 'asc'], ['$createdAt', 'asc']],
    limit: PAGE_SIZE, ...(startAfter ? { startAfter } : {}),
  });
  const comments: Comment[] = [];
  for (const doc of documents.values()) {
    if (doc) {
      try { comments.push(readComment(doc)); } finally { doc.free(); }
    }
  }
  return { comments, hasMore: comments.length === PAGE_SIZE };
}

/** Yappr's byte-preserving document builder pattern; the constructor loses binary types. */
export function buildCommentDocument(mod: SdkModule, contractId: string, ownerId: string, properties: Record<string, unknown>): Document {
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  // SDK types ask for Identifier instances, but fromObject requires raw identifier bytes.
  const value = {
    $formatVersion: '0',
    $id: mod.Document.generateId('comment', ownerId, contractId, entropy),
    $ownerId: identifierBytes(ownerId),
    $dataContractId: identifierBytes(contractId),
    $type: 'comment', $entropy: entropy,
    $createdAt: BigInt(Date.now()), ...properties,
  } as unknown as DocumentObject;
  const version = mod.PlatformVersion.current();
  try { return mod.Document.fromObject(value, version); } finally { version.free(); }
}

export interface PreparedComment {
  id: string;
  ownerId: string;
  contest: string;
  body: string;
  replyTo?: string;
  bytes: Uint8Array;
}

export async function prepareComment(
  handle: SdkHandle, contractId: string, session: DiscussionSession,
  contest: string, body: string, replyTo?: string,
): Promise<PreparedComment> {
  const properties = commentProperties(contest, body, replyTo);
  if (replyTo) {
    const parent = await handle.sdk.documents.get(contractId, 'comment', replyTo);
    try {
      if (!parent || parent.properties.contest !== contest) throw new Error('The reply must belong to this contest.');
    } finally { parent?.free(); }
  }
  const nonce = await handle.sdk.identities.contractNonce(session.identityId, contractId);
  const resources: { free(): void }[] = [];
  try {
    const document = buildCommentDocument(handle.mod, contractId, session.identityId, properties);
    resources.push(document);
    const create = new handle.mod.DocumentCreateTransition({ document, identityContractNonce: (nonce ?? 0n) + 1n });
    resources.push(create);
    const transition = create.toDocumentTransition();
    resources.push(transition);
    const batched = new handle.mod.BatchedTransition(transition);
    resources.push(batched);
    const batch = handle.mod.BatchTransition.fromBatchedTransitions([batched], session.identityId, 0);
    resources.push(batch);
    batch.signaturePublicKeyId = session.keyId;
    const state = batch.toStateTransition();
    resources.push(state);
    return { id: document.id.toString(), ownerId: session.identityId, contest, body: String(properties.body), replyTo, bytes: state.toBytes() };
  } finally {
    resources.reverse().forEach(resource => resource.free());
  }
}

export async function publishComment(handle: SdkHandle, session: DiscussionSession, prepared: PreparedComment): Promise<void> {
  if (!session.privateKey || prepared.ownerId !== session.identityId) throw new Error('Sign in again to publish this comment.');
  const identity = await handle.sdk.identities.fetch(session.identityId);
  if (!identity) throw new Error('Identity not found.');
  const keys = identity.publicKeys;
  let state: StateTransition | undefined;
  try {
    const key = keys.find(candidate => candidate.keyId === session.keyId && usableAuthKey(candidate));
    if (!key || key.getPublicKeyHash() !== session.privateKey.getPublicKeyHash()) throw new Error('This authentication key is no longer active.');
    state = handle.mod.StateTransition.fromBytes(prepared.bytes);
    state.sign(session.privateKey, key);
    await handle.sdk.stateTransitions.broadcastAndWait(state);
  } finally {
    state?.free(); keys.forEach(key => key.free()); identity.free();
  }
}

/** A wallet handoff is not success: verify the exact expected document. */
export async function commentConfirmed(handle: SdkHandle, contractId: string, prepared: PreparedComment): Promise<boolean> {
  const document = await handle.sdk.documents.get(contractId, 'comment', prepared.id);
  if (!document) return false;
  try {
    const comment = readComment(document);
    return comment.ownerId === prepared.ownerId && comment.contest === prepared.contest &&
      comment.body === prepared.body && comment.replyTo === prepared.replyTo;
  } finally { document.free(); }
}
