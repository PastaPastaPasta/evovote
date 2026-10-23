# EvoVote v2: the vote tool for everything contested (testnet first)

Status: r1, 2026-10-17. Owner decisions are recorded in section 2. Work packages are in section 9.

## 1. Goal

A production-quality, fully client-side site where:

- anyone can see every contested resource on Dash Platform: who is contending, live tallies,
  deadlines, outcomes and history;
- masternode operators can vote from the browser on any of them;
- identities can take part in **moderator elections** end to end: file reasons and a charter,
  ask to join a charter, accept members, and apply for the seat;
- people can discuss any contest on chain.

v2 targets **testnet** (protocol 14). Mainnet stays on v1 at vote.dashhq.org until mainnet runs
PV14. After that, v2 replaces v1.

## 2. Owner decisions (2026-10-17)

| # | Decision |
|---|---|
| O1 | v2 is built in the evovote repo, on the long-lived `v2` branch. It deploys to its own testnet subdomain. `main` and vote.dashhq.org stay v1 and untouched. |
| O2 | Moderator elections include the **candidate flow** (reasons, submittedCharter, joinRequest, electedCharter), not just voting. |
| O3 | Coverage: dedicated views for DPNS and moderator elections, plus a **generic** view for any contract's contested index. |
| O4 | Discussions (from `feat/contest-discussions`) are included. They are scoped to a poll key, not a DPNS label. Wallet `dash-st:`/`dash-key:` flows are dropped. |

## 3. Platform facts this rests on (verified 2026-10-17)

- Testnet: Drive 5.0.0-rc.4, protocol 14. The moderation charters system contract
  `EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88` is live. npm `@dashevo/evo-sdk@5.0.0-rc.4`.
- Any contract may declare **one** contested unique index per document type:
  `contested: { resolution, fieldMatches? }`.
  - Resolution 0 (`MasternodeVote`): contender / abstain / lock. DPNS uses this.
  - Resolution 1 (`MasternodeVoteNoLocking`): no Lock (40307). There is always a winner. A lone contender
    is awarded at join-window close. Ties go to the earliest contender. Moderator elections use this.
- Windows:
  - Generic polls on testnet: 45 min join, 90 min total. On mainnet: 1 week join, 2 weeks total.
  - Charter elections use the target contract's `joinWindow`/`voteWindow`. A second applicant
    moves the end to join + vote.
- Votes:
  - A vote is a `MasternodeVote` transition signed with the node's voting key (key id 0, ECDSA_HASH160).
  - The voter identity is `SHA256(proTxHash ‖ votingKeyHash160)`.
  - Weight is 1 for a masternode and 4 for an evonode.
  - A masternode has at most 5 votes per poll, counting the first (40303). Re-casting the same choice is refused (40304).
  - A vote for a non-contender is refused (40307).
- Moderator elections, using the charters contract:
  - Flow: `reason` → `submittedCharter` (leader) → `joinRequest` (members, encrypted to the leader) →
    `electedCharter` (leader). The `electedCharter` lists up to 15 members and prefunds 0.5 DASH, and creating it opens or joins
    the contest on `electedCharter.byTargetContract = [targetContractId]`.
  - Key requirements:
    - The leader needs a DECRYPTION/MEDIUM key bound to `submittedCharter`. Adding it is an identity update signed with the MASTER key.
    - A joiner needs an ENCRYPTION/MEDIUM key bound to `joinRequest`.
  - Seats are **permanent** on PV14. A second `electedCharter` for a seated target is refused (40105).
- Queries:
  - `voting.votePollsByEndDate`, `voting.contestedResourceVoteState`,
    `voting.contestedResourceIdentityVotes` and `voting.masternodeVote`.
  - `group.contestedResources` and `group.contestedResourceVotersForIdentity`. These sit under `group`, not `voting`.
  - `moderationCharters.{team, seatedCharter, submittedCharter(s), joinRequests, buildJoinRequest, ...}`.
- Prior working tooling, to be ported rather than rediscovered:
  - `~/.local/share/yappr-sakura-elections-20261007/*.mjs`: file-charter, join-request, mn-vote,
    election-status, polls.
  - Yappr `origin/staging:lib/services/moderation-election-service.ts`, a read-only election status with explicit `failures`.

Anything in this section that the rc.4 SDK contradicts must be re-verified live. Record the result in
`docs/V2_NOTES.md`.

## 4. Architecture

Stack: Vite, React 19 and TypeScript strict. Keep the v1 stack, and add ESLint.
`@dashevo/evo-sdk` is pinned to an exact 5.0 version.

```
src/
  sdk/          connection, network (URL ?network= > localStorage > default testnet), errors
  model/        PollKey, Contest, Contender, Tally, Phase; canonical encode/decode
  discovery/    active polls (votePollsByEndDate, time-bounded), archives (contestedResources per known index), contract index scan
  kinds/        ContestKind adapters: dpns, charter, generic (+ registry)
  voting/       masternode keyring, vote planner, batch broadcaster, receipts/verification
  identity/     identity session (key paste), key-purpose checks, identity-update helpers
  charters/     charter reads (team, proposals, reasons, join requests) + candidate writes
  discussion/   comment contract reads/writes, keyed by PollKey
  ui/           routes, pages, components
```

### 4.1 PollKey and routes

- `PollKey = { contractId, documentTypeName, indexName, indexValues: unknown[] }`. Its canonical string form is
  `contractId/docType/indexName/<base64url(cbor-or-json of indexValues)>`, used for routes, caches,
  receipts and the discussion scope.
- Decode index values through the SDK's Value types, not the v1 hand-rolled `0x12` parser.
- Routes use the hash router:
  - `#/`: the overview of all kinds.
  - `#/k/<kind>`: the list for one kind.
  - `#/p/<pollKey>`: a contest page.
  - `#/m/<targetContractId>`: a moderated contract's election hub.
  - `#/m/<target>/charter/<submittedCharterId>`: one proposal.
  - `#/c/<contractId>`: the generic browser for one contract.
  - `#/mn`: the masternode keyring.
  - `#/me`: the identity session.
  - `#/about`.
- Keep v1's `#/c/<label>` working as a redirect to the DPNS poll key.

### 4.2 ContestKind adapters

```ts
interface ContestKind {
  id: 'dpns' | 'charter' | 'generic';
  matches(key: PollKey): boolean;
  title(c: Contest): string;                       // "alice.dash", "Moderators of Yappr Social"
  describeContender(c: Contest, contenderId): Promise<ContenderView>; // decoded document → view model
  choices(c: Contest): VoteChoiceKind[];           // from the index's resolution: no Lock for resolution 1
  archive?: (sdk) => AsyncIterable<PollKey>;        // known-index sweep for decided contests
}
```

- **dpns**: v1 behaviour (label, homograph warnings, `.dash`), ported.
- **charter**:
  - The title is the target contract's display name. It comes from a small known-contracts registry
    (Yappr social/storefront/blog testnet ids from config) and falls back to the short id.
  - Each contender shows the leader's DPNS name, the charter description, reasons, `moderatorsShare`,
    `rewardSplit`, the members list, and links to the proposal page.
  - The contest card states "seat is permanent" and the tie rule (earliest wins).
- **generic**: the contract id, document type, index and decoded index values. Each contender shows its document
  fields as a key/value table. The resolution comes from the contract's index definition.

### 4.3 Discovery

- **Active:** page `votePollsByEndDate` with time bounds from now to now + max window. Use `offset` as a fallback
  if bounds misbehave. Group the polls by kind and fetch vote state with bounded concurrency (as v1 does).
- **Decided / archive:**
  - DPNS: the `contestedResources` sweep under the `dash` parent, as in v1.
  - Charters: `contestedResources` on `electedCharter.byTargetContract`, which lists every target ever contested.
  - Generic: when the user opens `#/c/<contractId>`, scan its document types for a contested index and sweep it.
- **Moderated-contract directory:**
  - Found on chain: the union of every target with a proposal (`submittedCharter`), every target found by the
    charters sweep (contested), every target with a seated team (`electedCharter`), and contract ids the user adds.
    The known-contracts config only labels contracts; it does not decide which are listed.
  - Sections: open contests; proposals waiting for a team to apply; filled seats; everything else.
  - Each entry shows its declaration (windows, interim, moderated types and abilities, `seatContestable`,
    `maxAddedModerators`) and its seated team (`moderationCharters.team`).
- **No silent truncation:** caps are explicit and shown ("showing first N").
- **Failures:** a failed read is never rendered as "none". Every async view model carries `failures[]`, following
  Yappr's `ElectionStatus` pattern.

### 4.4 Voting

- The keyring is generalized from v1 `mn.ts`:
  - ProTxHash, label and weight, discovered via the voter identity's existence and key.
  - WIFs are kept in memory only. Persisting them is opt-in and off by default.
  - The voter identity is derived and its key is checked against `hash160(pub)` before any vote is signed.
- The vote planner takes (polls × masternodes × choice). It shows each node's current vote, from
  `contestedResourceIdentityVotes` for that voter identity, and skips no-op re-votes (40304). It warns
  that a node has 5 votes per poll in total.
- The batch broadcaster runs sequentially per masternode, with bounded parallelism across masternodes (≤ 8).
  Failures can be retried, and every refusal code is mapped to plain words.
- Verification: confirm each vote by re-reading the voter's votes. Do not trust the resolved value, since it was
  `undefined` in older SDKs.

### 4.5 Identity session and the candidate flow

- **Login:** paste a private key. The identity is found by public-key hash. The session keeps only the keys needed,
  in memory, and states each key's purpose and security level.
  - A HIGH (or CRITICAL) AUTHENTICATION key is needed for document writes.
  - The MASTER key is needed only for the one-time identity update that adds an encryption or decryption key.
    It is asked for just-in-time and is not kept.
  - The browser generates the new encryption/decryption keypair and shows it to the user to back up. Without it,
    join requests cannot be decrypted.
  - Signed in with Dash Wallet, whose App Connect key cannot sign charter documents yet: the user may enter the
    wallet's recovery phrase instead of either key (an interim fix until wallets ship `dashpay://sign`). EvoVote
    derives the identity's DIP-13 keys as Dash Wallet does (`src/identity/dip13.ts`, `src/identity/phraseKeys.ts`),
    takes the one matching an enabled unbound HIGH/CRITICAL key (or the MASTER key), refuses a phrase of another
    identity, and holds the derived key exactly like a pasted one. The phrase is never stored.
- **Charter wizard** (`#/m/<target>`, "Propose a moderation team"):
  1. Choose or file `reason`s (code `^[A-Z]{3}$`, label, description). The leader's existing reasons are offered for reuse.
  2. Ensure the leader's decryption key exists.
  3. File the `submittedCharter`: description, reasons, `moderatorsShare` and `rewardSplit`. The split is validated to
     sum to 100 with one entry per seat.
- **Join** (proposal page): ensure the encryption key, then build with `moderationCharters.buildJoinRequest` and broadcast.
- **Leader dashboard:** decrypt join requests, choose members (up to 15), see the open contest and window, then
  **apply**. Applying creates the `electedCharter` with a 0.5 DASH prefund, behind a hard confirmation that shows the
  balance, cost, windows, the permanence and tie rules, and an explicit late-applicant check (40111).
- **Fees:** every paid write shows the estimated cost and current balance before signing. After broadcast, the write is
  confirmed by reading the document back.
- **Out of v2:** post-seat team management (added or removed moderators, resignations, bans). That belongs to Yappr.
  The election hub shows the seated team read-only.

### 4.6 Discussions

- Port `feat/contest-discussions`, keeping its reader, writer and verification, and change the scope to the canonical PollKey string.
  This needs a new contract version.
- Comment authors show their DPNS name, plus a contender badge when the author's identity is a contender in that
  contest. A charter contest's contender is the leader identity.
- The comment contract is published on testnet from a maker identity, and its id goes in config. A
  missing id renders as "discussion not activated", not as an error.
- Login uses the identity session from 4.5.

## 5. Security and safety

- Keys are never sent anywhere and never logged. WIF inputs are `autocomplete=off` and cleared after use. Add a strict
  CSP meta tag (self + DAPI hosts + wasm-unsafe-eval).
- Every irreversible or expensive action (a vote, `electedCharter`, an identity update) gets a confirm step whose summary
  is computed from the exact transition about to be signed.
- Network mismatch: refuse a WIF whose version byte does not match the selected network, and show the network
  in the header at all times. Testnet uses a distinct accent colour.

## 6. Quality bar ("production ready")

- ESLint, `tsc --noEmit` and Vitest in CI, plus a Playwright smoke run against a mock SDK.
- Unit tests:
  - PollKey encoding round-trips;
  - each kind adapter, against recorded fixtures;
  - the vote planner, including the 5-vote budget and no-op skip;
  - the refusal-code map;
  - charter validation (split sums, member caps, reason codes).
- Opt-in live tests (`npm run test:live`, testnet) for read paths.
- Live testnet QA before calling it done:
  - a throwaway elected contract with short windows;
  - two competing charters;
  - members joining;
  - testnet masternodes voting both ways;
  - the seat awarded;
  - DPNS contest voting;
  - a generic contest on a throwaway contract;
  - comments.
  Record the results in `docs/V2_QA.md`.
- Accessibility: keyboard reachable, labelled inputs, contrast in both themes. Responsive down to 360 px.

## 7. Deployment

- `v2` deploys to its own GitHub Pages site on a testnet subdomain. GitHub Pages allows one custom
  domain per repo, so the build is pushed to a small Pages-only repo. The repo name and subdomain (for example
  `vote-testnet.dashhq.org`) are confirmed with the owner before they are created.
- A single-level subdomain keeps Cloudflare's universal cert usable when it is orange-clouded.
- `main` keeps deploying v1 to vote.dashhq.org, unchanged.

## 8. Non-goals (v2)

- Wallet-signed votes or comments: no wallet holds voting keys. DashPay Connect v2 login is a follow-up.
- Seat challenges, which come after PV14.
- Mainnet, until PV14 is live there.

## 9. Work packages

| WP | Scope | Depends on |
|---|---|---|
| WP1 | Foundation: SDK 5.0 upgrade, `sdk/`, `model/`, discovery, kind registry + dpns adapter port, routes, generic voting (keyring, planner, broadcaster), ESLint/CI. v1 behaviour preserved on testnet. Verify section 3 facts live into `V2_NOTES.md`. | none |
| WP2 | Charter kind (read side): election hub, directory, proposal page, contest view + voting integration. | WP1 |
| WP3 | Identity session + candidate flow writes (reasons, keys, submittedCharter, joinRequest, leader dashboard, electedCharter). | WP1 (WP2 for pages) |
| WP4 | Discussions port, keyed by PollKey; testnet contract publish script. | WP1, WP3 session |
| WP5 | Generic kind + contract browser. | WP1 |
| WP6 | Live testnet QA, polish, deploy. | all |
