# EvoVote v2: verified Platform facts (WP1)

Checked on 2026-10-17 against testnet with `@dashevo/evo-sdk@5.0.0-rc.4` (Node 22, `EvoSDK.testnetTrusted()`)
and against the Platform source at tag `v5.0.0-rc.4`. Everything was read-only: no state transition was signed
or broadcast. The opt-in `npm run test:live` suite re-checks the facts marked **[live test]**.

Legend: ✅ confirmed · ⚠️ differs from design §3 (the code follows the verified behaviour) · ❔ not verifiable yet.

## Network and SDK

| Fact | How verified | Result |
|---|---|---|
| Testnet runs Drive 5.0.0-rc.4, protocol 14 | `system.status()` | ✅ DAPI and Drive `5.0.0-rc.4`, `protocol.drive.current = 14`. **[live test]** |
| `@dashevo/evo-sdk@5.0.0-rc.4` needs no separate `wasm-dpp2` | `npm view`, `npm ls` | ✅ Its only dependency is `@dashevo/wasm-sdk@5.0.0-rc.4` (wasm-dpp2 is compiled in). `package.json` pins evo-sdk exactly and overrides wasm-sdk to the same version, so one copy is bundled. The SDK chunk is 12.6 MB (was ~9 MB on 4.1.1). |
| `sdk.version()` | probe | ⚠️ Returns 13 right after `connect()` and 14 after the first query. Code that passes a platform version (e.g. `Document.fromBytes`) must read it after a query, as `voteState.ts` does. |
| WASM errors | probe + `wasm-sdk/src/error.rs` | ✅ `WasmSdkError`/`WasmDppError` are not `Error` instances. They carry `.message` and `.code`: the consensus code (e.g. 40304), or -1. `sdk/errors.ts` reads both. |
| DPNS and charters contract ids | `contracts.fetch` | ✅ DPNS `GWRSAV…S31Ec` and charters `EG7RGf…UmN88` exist on testnet. DPNS uses the same id on mainnet. |

## Contested indices

| Fact | How verified | Result |
|---|---|---|
| A contract declares `contested: { resolution, fieldMatches? }` on one unique index | `contract.toJSON().documentSchemas[t].indices` | ✅ DPNS `domain.parentNameAndLabel`: `resolution: 0`, `fieldMatches` `^[a-zA-Z01-]{3,19}$` on `normalizedLabel`. Charters `electedCharter.byTargetContract`: `resolution: 1`. `discovery/contracts.ts` reads it from there. **[live test]** |
| Resolution 1 refuses Lock with 40307 | rs-drive-abci `masternode_vote/state/v1` | ✅ `VoteChoiceNotAllowedForVotePollError` (40307) for Lock when the index is `MasternodeVoteNoLocking`. |
| A vote for a non-contender is refused with 40307 | same file | ✅ On PV14, `TowardsIdentity` must name a contender, else 40307. |

## Queries

| Fact | How verified | Result |
|---|---|---|
| `voting.votePollsByEndDate` time bounds | probe + **[live test]** | ✅ `startTimeMs`/`endTimeMs` accept `number` and `bigint` (the v1 catch-22 on 4.1.1 is gone). An entry's `timestampMs` is a `bigint` and can be passed back as the next page's start. |
| `votePollsByEndDate` `offset` | probe + **[live test]** | ⚠️ **Refused**: `decode request: VotePollsByEndDateDriveQuery.offset field is internal and must be set to None`. The design's "offset fallback" is impossible. `discovery/activePolls.ts` pages by time only. If the bounded query fails, it retries once without the upper bound. |
| Whether `limit` counts polls or buckets | ❔ | No active polls on testnet today (0 entries with and without bounds). The walk is correct either way: it stops only when both the poll count and the bucket count are below the page size. |
| `votePolls[].indexValues` encoding | rc.4 `VotePoll` probe + `wasm-dpp2/src/voting/vote_poll.rs` | ✅ Each value is `bincode::encode_to_vec(Value, standard().with_big_endian())`. The enum tag order is rs-platform-value's: Text `0x12`, Identifier `0x10`, U64 `0x02`, I64 `0x03`, Float `0x11`, Bool `0x13`, Null `0x14`, Array `0x15`. Integers use varints with zigzag for signed. The SDK has no Value class. `VotePoll.toJSON()` renders an Identifier as a base58 string that looks the same as Text. So `model/indexValue.ts` decodes the bytes itself and keeps the type. Its vectors came from rc.4. |
| `new VotePoll({ indexValues })` | probe | ⚠️ JS strings become Text, Identifier objects become **Text** (base58), integers become U64, and Uint8Array becomes an **Array of U8**. Only text, bool and null round-trip. A poll id hashes the typed values, so a rebuilt charter poll (Identifier on chain) addresses a nonexistent poll (40401). `voting/cast.ts` rebuilds only all-text/bool/null keys (DPNS). Everything else must use the `VotePoll` read from `votePollsByEndDate` (`livePollFor`). The SDK clones option objects (`impl_try_from_js_value` → `clone()`), so one live poll can sign many votes. |
| `voting.contestedResourceVoteState` | **[live test]** | ✅ It returns `contenders[]` (`identityId`, `voteTally`, `serializedDocument`), `abstainVoteTally`, `lockVoteTally` and `winner` (`kind` `"WonByIdentity"`/`"Locked"`, `identityId`, `block.timeMs` bigint). Decided contests return `serializedDocument: undefined` and zero voters. Index values are passed as plain JS values. |
| `group.contestedResources` (under `group`, not `voting`) | **[live test]** | ✅ DPNS with `startIndexValues: ['dash']` returns the next index value as plain strings (`"000"`, `"0000"`, …). There are 1033 on testnet. Without a prefix it returns `["dash"]`. |
| `group.contestedResources` on `electedCharter.byTargetContract` | **[live test]** | ✅ Works and returns `[]`: no moderator election has been contested on testnet yet. The element shape for an Identifier value (base58 string vs bytes) is ❔; `kinds/charter.ts` accepts both. |
| `group.contestedResourceVotersForIdentity` | source | ✅ The voters are **ProTxHashes**: Drive stores each vote under the voter's ProTxHash. v1 called them "voter identity IDs". The UI now shows them as ProTxHash hex. |
| `voting.contestedResourceIdentityVotes` shape | types + probe | ✅ Returns `Map<voteId, ResourceVote>`. `ResourceVote` has `poll: VotePoll` and `choice: ResourceVoteChoice`, and `choice.toJSON()` is `{ $type: 'towardsIdentity', identity } \| { $type: 'abstain' } \| { $type: 'lock' }`. No masternode has a recorded vote today, so a non-empty result is ❔. |
| Which id `contestedResourceIdentityVotes` takes | rs-drive `register_contested_resource_identity_vote` | ⚠️ **ProTxHash, not the voter identity.** Drive keys a masternode's votes (and its vote count) by `voter_pro_tx_hash`. The design said "for that voter identity". `voting/currentVotes.ts` queries with the ProTxHash as base58 of the Core-order bytes. The query returns the current choice only. **How many of the 5 votes were spent is not exposed**, so the planner's budget is a lower bound: this browser's receipts, or 1 when a current vote exists. **[live test]** checks that the call succeeds. |
| `moderationCharters` facade | **[live test]** | ✅ `seatedCharter`, `submittedCharter`, `team`, `submittedCharters`, `joinRequests`, `pendingResignationRequests`, `buildJoinRequest` and `buildResignationRequest` all exist. |

## Votes

| Fact | How verified | Result |
|---|---|---|
| Voter identity = `SHA256(proTxHash ‖ votingKeyHash160)` | 40 enabled testnet masternodes: ProTxHash from `quorums.testnet.networks.dash.org/masternodes`, voting address from each ProRegTx (insight), then `identities.fetch` | ✅ For all 40, the id derived from the ProTxHash **in Core display order** exists. The byte-reversed order never does. Its key 0 is `purpose 5 (VOTING)`, `securityLevel 2 (HIGH)`, `type 2 (ECDSA_HASH160)`, `readOnly`, and `data` is that hash160. Voter identities exist for every masternode, not only ones that have voted. Test vectors are in `voting/keys.test.ts`. **[live test]** |
| An old voting key after a ProUpRegTx | rs-drive-abci `update_masternode_identities/disable_identity_keys` | ✅ When the masternode list changes a node, Platform disables the old voter identity's keys (`disabledAt`). The keyring therefore refuses a key 0 that has `disabledAt`. A key changed in the last few blocks can still pass and then earn 40305. |
| `masternodeVote` ProTxHash forms | rc.4 `MasternodeVoteOptions` docs + `Identifier` probe | ✅ Accepts an `Identifier`, 32 bytes, Core RPC hex, or base58. `new Identifier(hex).toHex()` round-trips. The code passes base58 of the hex bytes, because a hex string could also parse as base58. |
| `masternodeVote` return value | `wasm-sdk/src/state_transitions/identity.rs` @ rc.4 | ✅ It signs, broadcasts, waits for the block, verifies the proof, and resolves with the recorded `Vote`. The app still confirms each vote by re-reading the node's votes (`verifyVote`), as design §4.4 asks. |
| Vote key | same + IdentityPublicKey probe | ✅ `new IdentityPublicKey({ keyId: 0, purpose: 'voting', securityLevel: 'high', keyType: 'ecdsa_hash160', isReadOnly: true, data: hash160 })` builds the exact key the voter identity holds. Both lower- and upper-case enum names are accepted. |
| 5 votes per poll, counting the first (40303); same choice refused (40304) | rs-drive-abci `masternode_vote/transform_into_action/v0` | ✅ The same choice gives 40304. 40303 applies when `previous_vote_count >= votes_allowed_per_masternode`. |
| Weight 1 / 4 | ❔ | Not checked in WP1 (no browser-side masternode-type source). The keyring does not show weight yet. |
| Consensus codes used by the refusal map | rs-dpp `errors/consensus/codes.rs` @ rc.4 | ✅ 40105, 40110, 40111, 40204, 40300–40307, 40400, 40401. |

## Moderator elections and the identity session (WP2/WP3)

Checked on 2026-10-17 against testnet (rc.4), read-only. **[live test]** marks the facts `npm run test:live` re-checks.

| Fact | How verified | Result |
|---|---|---|
| No charter activity on testnet yet | `documents.query` on every charters type; `contestedResources` sweep | ✅ 0 `reason`, `submittedCharter`, `joinRequest` and `electedCharter` documents, and no contested target. The directory (`#/m`) is empty unless a contract is configured or added. **[live test]** |
| Contract JSON carries `createdAt` | `contract.toJSON(14)` | ✅ A top-level `createdAt` (ms), `null` on system contracts. `electionDelay` is measured from it; a contract with no `createdAt` never opens an election that declares a delay. |
| Elected declaration shape | wasm-sdk `ContractModerators` typings + Platform book | ⚠️ Not seen live (no elected contract on testnet). `charters/declaration.ts` reads `config.moderation.moderators` with `$type: 'elected'` and defaults missing windows to one week, as the book says. |
| The fund to join a moderator election | `documents.contestFundToJoin(electedCharter)` | ✅ 50,000,000,000 credits (0.5 DASH) for a contest with no contenders. **[live test]** `documents.create({ contestFund })` states it; no hand-built `$prefundedVotingBalance` is needed. |
| Fee estimates | wasm `documentCreateCost(contract, type, opts, 14)` | ✅ Works offline from the contract. Defaults (newValues): `reason` 0.00046, `submittedCharter` 0.00148, `joinRequest` 0.00066, `electedCharter` 0.00043 DASH plus the 0.5 DASH fund (reported in `contractCharges`). **[live test]** Identity updates have no estimator; the app uses 0.001 DASH. |
| Identifier properties in document JSON | probes | ⚠️ A document read from chain renders identifiers as base58 (and `properties` holds strings); one built with `Document.fromObject` without its contract renders them as base64. Integers in a built document come back as `bigint`. `charters/documents.ts` `idFromValue` accepts every form. |
| Identity by key hash | `identities.byPublicKeyHash` | ✅ Finds an identity by the HASH160 of an ECDSA_SECP256K1 key. The session falls back to `byNonUniquePublicKeyHash` (ECDSA_HASH160 keys) and asks the user to pick when several share it. **[live test]** |
| Key getters | `IdentityPublicKey` probe | ✅ `purpose`/`securityLevel`/`keyType` are upper-case strings (`DECRYPTION`, `MEDIUM`, `ECDSA_SECP256K1`), `data` is hex, `contractBounds.toJSON()` is `{ $type: 'documentType', id, documentTypeName }`. |

### Write paths not verified live

Nothing was signed or broadcast in WP2/WP3. Unit tests build and sign with throwaway keys against a mocked SDK. WP6 must
run each of these on a throwaway elected contract: `reason` create, the identity update adding a DECRYPTION key bound to
`submittedCharter` (MASTER-signed, the new key signing its own proof), `submittedCharter` create, the identity update adding
an ENCRYPTION key bound to `joinRequest`, `buildJoinRequest` + create, `encryptedFor.decrypt` of a join request by the
leader, and the `electedCharter` create with `contestFund` (first applicant, second applicant, late applicant → 40111,
after seating → 40105). Also check that integer properties built as JS numbers are accepted on rc.4 (they were on the
5.0 betas).

## Not verified in WP1

- **Live voting**: by design, there were no keys and no broadcasts. The full sign → broadcast → read-back path needs testnet masternode keys (WP6 QA).
- **An active poll's real `indexValues` bytes**: testnet had no open polls. The DPNS decoding is covered by v1 mainnet history and rc.4's own encoder vectors. The charter Identifier tag `0x10` comes from the Sakura tooling on 5.0 betas.
- **Charter windows, the second-applicant extension, seats being permanent (40105)**, and the moderation flow are WP2/WP3 material.

## Ops notes

- Some testnet evonodes (`85.209.243.x`) answer browser requests without CORS headers. The SDK fails over to other nodes, but the browser console logs the failures.
