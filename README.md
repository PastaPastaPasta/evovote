# EvoVote

Live tallies for **contested Dash usernames**, read straight from Dash
Platform — plus in-browser masternode voting.

**https://vote.dashhq.org/**

## What it does

- Lists every active DPNS username contest with vote tallies, end-time
  countdowns, and per-contender voter lists.
- Generates a wallet signing request for each official vote using public
  ProTxHash and voting address; no voting private key is needed in the browser.
- Also lets masternode owners cast votes (for a contender, abstain, or lock)
  directly from the browser — including owners of **multiple masternodes**,
  with bulk import and per-masternode broadcast status.
- No backend. Every query and every vote goes from your browser to Dash
  Platform nodes via [`@dashevo/evo-sdk`](https://www.npmjs.com/package/@dashevo/evo-sdk)
  (WASM, proof-verified queries).

## Security model

- Voting keys (WIFs) are held **in memory only** — never persisted, never
  transmitted. Signing happens locally in WASM; only the signed state
  transition is broadcast.
- ProTxHashes and labels (public information) are kept in `localStorage`
  for convenience.
- Official masternode voting uses the registered
  **voting address** key (`protx info` → `votingAddress`). Never enter
  owner, operator (BLS), or collateral keys anywhere.
- Vote tallies are requested as `voteTally` only, so serialized contender
  documents never enter the render path (the class of bug that garbled
  dash.vote).

## Contest discussions

Each contest has a public discussion backed by a separate Dash Platform data
contract, with comments and replies authored by normal Platform identities.
Masternode voting identities still cast official votes; discussion activity does
not count toward those tallies.

Wallet login uses Yappr's `dash-key:` exchange protocol. The response discovers
identity from its Platform document owner; the browser discards the exchanged
login secret and does not register a delegated signing key. Each comment produces
its own unsigned `dash-st:` request for the wallet to sign and broadcast. The app
checks the exact resulting document before reporting success. Official wallet
votes verify the current ballot choice after the voter nonce advances; this is
a state check, not proof that a particular unsigned request executed. A wallet
must support the corresponding comment or masternode-vote transition type.

Alternatively, paste an authentication private key (hex or Dash WIF). EvoVote
looks up the identity by public-key hash, then verifies that the matching key is
active, unbound, and AUTHENTICATION/HIGH or CRITICAL. Multiple matches are shown
for selection. Only the public hash is queried. The private key lives in memory
and is released on logout or leaving the contest page; it is never stored.

Comments are plain text, public, permanent, limited to 2,000 Unicode characters,
and paid for with the author's Platform credits. Replies reference a comment in
the same contest. The application validates that relationship; Platform schema
validation alone does not enforce cross-document relationships. Discussion is
scoped to the normalized name and shares its history across repeated contests.
No fee sponsorship or general-purpose community polls are included.

### Activate the contract

1. Choose a funded Platform owner identity with a CRITICAL authentication key.
2. Run `npm run contract:prepare -- testnet <owner-identity-id>` (or `mainnet`).
   This reads the current nonce and writes `discussion-contract.local.json`
   containing the validated schema, expected contract ID and unsigned wallet
   request. It does not sign or broadcast. Review the JSON and open its `uri` in
   a compatible wallet to publish. Regenerate if the identity nonce changes.
3. Fetch that contract ID from the same network and verify the owner and schemas
   match `contracts/discussion.json` before configuring the application.
4. Copy `.env.example` to `.env.local` and set the corresponding discussion ID.
   Set the key-exchange contract ID to a deployed Yappr-compatible
   `loginKeyResponse` contract on that network. Verify this contract independently;
   contract IDs are never shared implicitly between networks.
5. For GitHub Pages, set the same public names as repository Actions variables;
   the deployment workflow passes them to Vite. Rebuild to activate.

A missing discussion ID shows an activation notice. A missing exchange ID leaves
key login available and explains why wallet login is unavailable. The deployment
and wallet round trip must be verified with a funded identity before release.

## Development

```sh
npm install
npm run dev        # local dev server
npm run build      # typecheck + production build to dist/
```

Deploys to GitHub Pages automatically on push to `main`
(`.github/workflows/deploy.yml`).

## License

MIT
