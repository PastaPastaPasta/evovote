# EvoVote

Live tallies for **contested Dash usernames**, read straight from Dash
Platform — plus in-browser masternode voting.

**https://pastapastapasta.github.io/evovote/**

## What it does

- Lists every active DPNS username contest with vote tallies, end-time
  countdowns, and per-contender voter lists.
- Lets masternode owners cast votes (for a contender, abstain, or lock)
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
- The only key this app ever needs is the masternode's registered
  **voting address** key (`protx info` → `votingAddress`). Never enter
  owner, operator (BLS), or collateral keys anywhere.
- Vote tallies are requested as `voteTally` only, so serialized contender
  documents never enter the render path (the class of bug that garbled
  dash.vote).

## Discussion

Masternode voter identities hold a single read-only `VOTING` key and no
credits, so they cannot post. v2 lets any Platform identity comment on a
contest through a small, immutable discussion contract (`contracts/discussion.json`),
signed in the browser with the identity session (`#/me`). Comments are scoped
to a contest by the SHA-256 of its canonical poll key. The contract id is a
build variable (`VITE_DISCUSSION_TESTNET_CONTRACT_ID` /
`VITE_DISCUSSION_MAINNET_CONTRACT_ID`); where it is unset the page says
discussion is not activated. See `docs/V2_NOTES.md`.

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
