import type { EvoSDK } from '@dashevo/evo-sdk';
import { fetchContract } from '../discovery/contracts';
import { invalidateContest } from '../discovery/voteState';
import { charterPollKey } from './pollKey';
import { base58Decode } from '../model/bytes';
import { dashText } from '../model/credits';
import { encodePollKey } from '../model/pollKey';
import type { SdkHandle } from '../sdk/connection';
import { freeQuietly } from '../sdk/free';
import { settleWrite, type WriteOutcome } from '../identity/outcome';
import type { DocumentSigner } from '../identity/session';
import { electedOf } from './declaration';
import { encryptedSize } from './boundKeys';
import { CHARTERS_CONTRACT_ID, idFromValue, type RewardSplit } from './documents';
import { canApply, type ApplyCheck } from './phase';
import {
  fetchCharterContest,
  fetchElectionStatus,
  fetchJoinRequests,
  fetchProposal,
  fetchProposalsByLeader,
  fetchTeam,
  forEachJoinRequest,
  type ElectionStatus,
} from './reads';
import { validateCharter, validateMembers, validateReason, type CharterInput, type ReasonInput } from './validate';

/**
 * The candidate flow's writes on the moderation charters contract, design
 * §4.5: `reason` → `submittedCharter` → `joinRequest` → `electedCharter`.
 *
 * Every write is priced and checked against the balance before signing, and
 * confirmed by reading it back. Nothing here runs without an explicit call
 * from a confirm step in the UI.
 */

type SdkModule = SdkHandle['mod'];
type WasmDocument = InstanceType<SdkModule['Document']>;
export type CharterDocType = 'reason' | 'submittedCharter' | 'joinRequest' | 'electedCharter';

/** 0.5 DASH, the protocol-14 fund a moderator election application prefunds. */
export const MODERATION_CONTEST_FUND = 50_000_000_000n;

const idBytes = (id: string): Uint8Array => {
  const bytes = base58Decode(id);
  if (bytes.length !== 32) throw new Error(`Not an identifier: ${id}`);
  return bytes;
};

/**
 * A new document of the charters contract. Built with `Document.fromObject`
 * so identifier properties stay bytes (the constructor would turn them into
 * arrays of numbers, refused as "not an array of bytes"). The id is a
 * placeholder: `documents.create` derives the real one from the nonce.
 */
export function newCharterDocument(
  mod: SdkModule,
  type: CharterDocType,
  ownerId: string,
  properties: Record<string, unknown>,
): WasmDocument {
  const object = {
    $formatVersion: '0',
    $id: new Uint8Array(32),
    $ownerId: idBytes(ownerId),
    $dataContractId: idBytes(CHARTERS_CONTRACT_ID),
    $type: type,
    $revision: 1n,
    $entropy: crypto.getRandomValues(new Uint8Array(32)),
    ...properties,
  };
  return mod.Document.fromObject(object as unknown as Parameters<SdkModule['Document']['fromObject']>[0], mod.PlatformVersion.latest());
}

export function reasonProperties(input: ReasonInput): Record<string, unknown> {
  const description = input.description?.trim();
  return {
    code: input.code,
    label: input.label.trim(),
    ...(description ? { description } : {}),
  };
}

export function submittedCharterProperties(targetContractId: string, input: CharterInput): Record<string, unknown> {
  return {
    targetContractId: idBytes(targetContractId),
    description: input.description.trim(),
    reasons: input.reasonIds.map(idBytes),
    rewardSplit: { ...input.rewardSplit },
    ...(input.moderatorsShare !== undefined ? { moderatorsShare: input.moderatorsShare } : {}),
  };
}

export function electedCharterProperties(
  targetContractId: string,
  submittedCharterId: string,
  members: readonly string[],
): Record<string, unknown> {
  return {
    targetContractId: idBytes(targetContractId),
    submittedCharterId: idBytes(submittedCharterId),
    members: members.map(idBytes),
  };
}

/** What a built document says, read back from the wasm object (for confirm steps). */
export function documentSummary(doc: WasmDocument): Record<string, unknown> {
  const props = doc.properties;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v instanceof Uint8Array) out[k] = idFromValue(v) ?? v;
    else if (Array.isArray(v)) out[k] = v.map((x) => (x instanceof Uint8Array ? (idFromValue(x) ?? x) : x));
    else out[k] = v;
  }
  return out;
}

// ---- prices ----------------------------------------------------------------

export interface WriteCost {
  /** Storage + processing, the larger of Drive's two scenarios (credits). */
  fees: bigint;
  /** The contest fund an application states (credits); 0 for other writes. */
  contestFund: bigint;
  total: bigint;
}

/** A field's size for the estimator: its length, or 'absent' for an optional field left out. */
export type FieldSize = number | 'absent';

/**
 * Price a create with Drive's own estimator (`documentCreateCost`, no
 * network): the document's variable sizes are passed in, so the estimate is
 * of this document, not of an average one.
 */
export async function estimateCreate(
  handle: SdkHandle,
  type: CharterDocType,
  sizes: Record<string, FieldSize> = {},
  opts: { contestFund?: bigint; contenders?: number } = {},
): Promise<WriteCost> {
  const contract = await fetchContract(handle.sdk, CHARTERS_CONTRACT_ID);
  if (!contract) throw new Error('The moderation charters contract could not be read.');
  const fields: Record<string, { present?: boolean; length?: number }> = {};
  for (const [name, size] of Object.entries(sizes)) {
    fields[name] = size === 'absent' ? { present: false } : { length: size };
  }
  const cost = handle.mod.documentCreateCost(
    contract,
    type,
    { fields, ...(opts.contenders !== undefined ? { contenders: opts.contenders } : {}) },
    handle.sdk.version(),
  );
  const fees = BigInt(Math.ceil(Math.max(cost.totalCredits.newValues, cost.totalCredits.knownValues)));
  const contestFund = opts.contestFund ?? 0n;
  return { fees, contestFund, total: fees + contestFund };
}

// Text sizes are passed in UTF-8 bytes: never fewer than the characters, so
// the estimate errs high.
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

export function estimateReason(handle: SdkHandle, input: ReasonInput): Promise<WriteCost> {
  const description = input.description?.trim() ?? '';
  return estimateCreate(handle, 'reason', {
    label: utf8Bytes(input.label.trim()),
    description: description ? utf8Bytes(description) : 'absent',
  });
}

export function estimateCharter(handle: SdkHandle, input: CharterInput): Promise<WriteCost> {
  return estimateCreate(handle, 'submittedCharter', {
    description: utf8Bytes(input.description.trim()),
    reasons: input.reasonIds.length,
    ...(input.moderatorsShare === undefined ? { moderatorsShare: 'absent' as const } : {}),
  });
}

export function estimateJoinRequest(handle: SdkHandle, message: string): Promise<WriteCost> {
  return estimateCreate(handle, 'joinRequest', { encryptedMessage: encryptedSize(utf8Bytes(message)) });
}

/** The identity's balance, read fresh before a confirm step. */
export async function readBalance(sdk: EvoSDK, identityId: string): Promise<bigint> {
  const balance = await sdk.identities.balance(identityId);
  if (balance === undefined) throw new Error('The identity balance could not be read.');
  return balance;
}

// ---- create and confirm ------------------------------------------------------

async function getDocument(sdk: EvoSDK, type: CharterDocType, id: string, ownerId: string): Promise<string | undefined> {
  const doc = await sdk.documents.get(CHARTERS_CONTRACT_ID, type, id);
  if (!doc) return undefined;
  try {
    return doc.ownerId.toBase58() === ownerId ? id : undefined;
  } finally {
    freeQuietly(doc);
  }
}

/**
 * Create `doc` and confirm it by reading it back. `find` locates it when the
 * create threw without a verdict (the id is only known once Platform answers).
 */
async function createAndConfirm(
  handle: SdkHandle,
  signer: DocumentSigner,
  doc: WasmDocument,
  type: CharterDocType,
  find: () => Promise<string | undefined>,
  contestFund?: bigint,
): Promise<WriteOutcome<string>> {
  const { sdk } = handle;
  return settleWrite(
    async () => {
      const created = await sdk.documents.create({
        document: doc,
        identityKey: signer.identityKey,
        signer: signer.signer,
        ...(contestFund !== undefined ? { contestFund } : {}),
      });
      try {
        return created.id.toBase58();
      } finally {
        freeQuietly(created);
      }
    },
    async (id) => (id ? getDocument(sdk, type, id, signer.identityId) : find()),
  );
}

export async function fileReason(
  handle: SdkHandle,
  signer: DocumentSigner,
  input: ReasonInput,
): Promise<WriteOutcome<string>> {
  const problems = validateReason(input);
  if (problems.length > 0) throw new Error(problems.join(' '));
  const doc = newCharterDocument(handle.mod, 'reason', signer.identityId, reasonProperties(input));
  try {
    return await createAndConfirm(handle, signer, doc, 'reason', async () => {
      const page = await handle.sdk.documents.query({
        dataContractId: CHARTERS_CONTRACT_ID,
        documentTypeName: 'reason',
        where: [
          ['$ownerId', '==', signer.identityId],
          ['code', '==', input.code],
        ],
        limit: 1,
      });
      const [id] = page.keys();
      page.forEach(freeQuietly);
      return id;
    });
  } finally {
    freeQuietly(doc);
  }
}

export async function fileCharter(
  handle: SdkHandle,
  signer: DocumentSigner,
  targetContractId: string,
  input: CharterInput,
): Promise<WriteOutcome<string>> {
  const problems = validateCharter(input);
  if (problems.length > 0) throw new Error(problems.join(' '));
  const doc = newCharterDocument(
    handle.mod,
    'submittedCharter',
    signer.identityId,
    submittedCharterProperties(targetContractId, input),
  );
  try {
    // Snapshot the leader's proposals so the fallback lookup can only match
    // a new one, never an older proposal with the same text.
    const before = await fetchProposalsByLeader(handle.sdk, signer.identityId)
      .then((ps) => new Set(ps.map((p) => p.id)))
      .catch(() => undefined);
    const description = input.description.trim();
    return await createAndConfirm(handle, signer, doc, 'submittedCharter', async () => {
      if (!before) return undefined;
      const mine = await fetchProposalsByLeader(handle.sdk, signer.identityId);
      return mine.find(
        (p) => !before.has(p.id) && p.targetContractId === targetContractId && p.description === description,
      )?.id;
    });
  } finally {
    freeQuietly(doc);
  }
}

/**
 * Ask to join a proposal. `buildJoinRequest` picks the leader's decryption
 * key and the writer's encryption key (both must be on chain), encrypts the
 * message and fills the key ids.
 */
export async function fileJoinRequest(
  handle: SdkHandle,
  signer: DocumentSigner,
  args: { submittedCharterId: string; message: string; encryptionPrivateKeyHex: string },
): Promise<WriteOutcome<string>> {
  const { sdk, mod } = handle;
  const writerEncryptionKey = mod.PrivateKey.fromHex(args.encryptionPrivateKeyHex, handle.network);
  let doc: WasmDocument | undefined;
  try {
    doc = await sdk.moderationCharters.buildJoinRequest({
      submittedCharterId: args.submittedCharterId,
      message: args.message,
      writer: signer.identityId,
      writerEncryptionKey,
    });
    return await createAndConfirm(handle, signer, doc, 'joinRequest', async () => {
      const { requests } = await fetchJoinRequests(sdk, args.submittedCharterId);
      return requests.find((r) => r.memberId === signer.identityId)?.id;
    });
  } finally {
    freeQuietly(doc);
    freeQuietly(writerEncryptionKey);
  }
}

// ---- the leader's view of join requests --------------------------------------

export interface DecryptedJoinRequest {
  id: string;
  memberId: string;
  createdAtMs?: number;
  /** The message, or undefined when it could not be decrypted. */
  message?: string;
  error?: string;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decrypt a proposal's join requests with the leader's decryption key. The
 * scheme has no authentication tag: a wrong key passes the padding check
 * about once in 256 tries and yields garbage, so non-UTF-8 output is
 * reported as unreadable.
 */
export async function decryptJoinRequests(
  handle: SdkHandle,
  submittedCharterId: string,
  decryptionPrivateKeyHex: string,
): Promise<{ requests: DecryptedJoinRequest[]; capped: boolean }> {
  const { sdk, mod } = handle;
  const contract = await fetchContract(sdk, CHARTERS_CONTRACT_ID);
  if (!contract) throw new Error('The moderation charters contract could not be read.');
  const recipientPrivateKey = mod.PrivateKey.fromHex(decryptionPrivateKeyHex, handle.network);
  const version = sdk.version();
  const requests: DecryptedJoinRequest[] = [];
  try {
    const { capped } = await forEachJoinRequest(sdk, submittedCharterId, async (raw, id) => {
      const doc = raw as WasmDocument;
      const json = doc.toJSON(version) as Record<string, unknown>;
      const memberId = idFromValue(json.$ownerId) ?? '';
      const entry: DecryptedJoinRequest = {
        id,
        memberId,
        createdAtMs: typeof json.$createdAt === 'number' ? json.$createdAt : undefined,
      };
      requests.push(entry);
      const senderKeyId = Number(json.senderKeyId);
      let sender: Awaited<ReturnType<typeof sdk.identities.fetch>>;
      let senderKey: ReturnType<NonNullable<typeof sender>['getPublicKeyById']>;
      // One bad request must not stop the others from being read.
      try {
        sender = Number.isInteger(senderKeyId) && memberId ? await sdk.identities.fetch(memberId) : undefined;
        senderKey = sender?.getPublicKeyById(senderKeyId);
        if (!senderKey) {
          entry.error = "The member's encryption key could not be read.";
          return;
        }
        const plain = await sdk.encryptedFor.decrypt({
          dataContract: contract,
          document: doc,
          property: 'encryptedMessage',
          recipientPrivateKey,
          senderKey,
        });
        entry.message = strictUtf8.decode(plain);
      } catch {
        entry.error = 'The message could not be decrypted with this key.';
      } finally {
        freeQuietly(senderKey);
        freeQuietly(sender);
      }
    });
    return { requests, capped };
  } finally {
    freeQuietly(recipientPrivateKey);
  }
}

// ---- applying for the seat ---------------------------------------------------

export interface ApplyPreflight {
  status: ElectionStatus;
  check: ApplyCheck;
  /** Problems that block the application (each would be refused, paid). */
  blockers: string[];
  warnings: string[];
  balance: bigint;
  cost: WriteCost;
  joinWindowSeconds?: number;
  voteWindowSeconds?: number;
}

/**
 * Everything checked before the hard confirm of an application. Reads the
 * election fresh: the target must be elected (40135), its seat free
 * (40105), the join window open (40111), the leader not yet a contender
 * (40112), the proposal the leader's and for this target, every member a
 * joiner (40120), and the balance enough for the fund and the fees.
 */
export async function preflightApply(
  handle: SdkHandle,
  args: { targetContractId: string; leaderId: string; submittedCharterId: string; members: readonly string[] },
  now = Date.now(),
): Promise<ApplyPreflight> {
  const { sdk } = handle;
  const [status, proposal, joiners, balance] = await Promise.all([
    fetchElectionStatus(sdk, args.targetContractId, { force: true, now }),
    fetchProposal(sdk, args.submittedCharterId),
    fetchJoinRequests(sdk, args.submittedCharterId),
    readBalance(sdk, args.leaderId),
  ]);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const check = canApply(status.timing, now);
  if (!check.ok) blockers.push(check.reason);
  else if (check.warning) warnings.push(check.warning);
  for (const f of status.failures) warnings.push(`Could not read ${f.source}: ${f.message}`);

  if (!proposal) blockers.push('The proposal could not be found.');
  else {
    if (proposal.leaderId !== args.leaderId) blockers.push('Only the proposal\'s leader can apply with it.');
    if (proposal.targetContractId !== args.targetContractId) blockers.push('This proposal is for a different contract.');
  }
  if (status.contest?.tally.contenders.some((c) => c.identityId === args.leaderId)) {
    blockers.push('You have already applied in this contest (an identity can apply once; 40112).');
  }
  blockers.push(
    ...validateMembers({
      leaderId: args.leaderId,
      members: args.members,
      joiners: new Set(joiners.requests.map((r) => r.memberId)),
    }),
  );

  // The fund Platform asks for now, from the application as it will be built.
  let contestFund = MODERATION_CONTEST_FUND;
  const application = buildApplication(handle.mod, args);
  try {
    const fund = await contestFundToJoin(handle, application);
    if (fund === undefined) blockers.push('Platform does not see this application joining a contest, so it was not built right.');
    else contestFund = fund;
  } catch {
    warnings.push('The current contest fund could not be read; 0.5 DASH is assumed.');
  } finally {
    freeQuietly(application);
  }
  const cost = await estimateCreate(
    handle,
    'electedCharter',
    { members: args.members.length },
    { contestFund, contenders: status.contest?.tally.contenders.length ?? 0 },
  );
  if (balance < cost.total) {
    blockers.push(`The balance (${dashText(balance)}) does not cover the fund and fees (${dashText(cost.total)}).`);
  }
  const elected = status.moderation ? electedOf(status.moderation) : undefined;
  return {
    status,
    check,
    blockers,
    warnings,
    balance,
    cost,
    joinWindowSeconds: elected?.joinWindowSeconds,
    voteWindowSeconds: elected?.voteWindowSeconds,
  };
}

/**
 * Build the application, for the confirm step to show what will be signed.
 * The caller frees it (or passes it to `applyForSeat`).
 */
export function buildApplication(
  mod: SdkModule,
  args: { targetContractId: string; leaderId: string; submittedCharterId: string; members: readonly string[] },
): WasmDocument {
  return newCharterDocument(
    mod,
    'electedCharter',
    args.leaderId,
    electedCharterProperties(args.targetContractId, args.submittedCharterId, args.members),
  );
}

/**
 * Apply for the seat: create the `electedCharter`, stating the contest fund
 * (the most it pays; Platform charges the fund to join, 0.5 DASH below 250
 * contenders). An application is not stored as a document until it wins, so
 * it is confirmed by finding the leader among the contest's contenders.
 */
export async function applyForSeat(
  handle: SdkHandle,
  signer: DocumentSigner,
  application: WasmDocument,
  targetContractId: string,
  contestFund: bigint = MODERATION_CONTEST_FUND,
): Promise<WriteOutcome<string>> {
  const { sdk } = handle;
  const keyString = encodePollKey(charterPollKey(targetContractId));
  const outcome = await settleWrite(
    async () => {
      const created = await sdk.documents.create({
        document: application,
        identityKey: signer.identityKey,
        signer: signer.signer,
        contestFund,
      });
      freeQuietly(created);
    },
    async () => {
      invalidateContest(keyString);
      const contest = await fetchCharterContest(sdk, targetContractId, true);
      if (contest?.tally.contenders.some((c) => c.identityId === signer.identityId)) return signer.identityId;
      // With a 0-second join window (allowed off mainnet) a lone applicant
      // is seated at once and may already have left the contender list.
      const team = await fetchTeam(sdk, targetContractId);
      return team?.leaderId === signer.identityId ? signer.identityId : undefined;
    },
    { attempts: 6, delayMs: 3000 },
  );
  invalidateContest(keyString);
  return outcome;
}

/** The contest fund Platform asks to join now (0.5 DASH, doubling past 250 contenders). */
export async function contestFundToJoin(handle: SdkHandle, application: WasmDocument): Promise<bigint | undefined> {
  const fund = await handle.sdk.documents.contestFundToJoin(application);
  if (!fund) return undefined;
  try {
    return fund.credits;
  } finally {
    freeQuietly(fund);
  }
}

export type { RewardSplit };
