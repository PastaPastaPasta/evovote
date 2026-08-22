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

## Why there are no comments on contests

Masternode voter identities are created automatically by Platform with a
single read-only `VOTING` key and no credits — they cannot create documents,
so they cannot post comments. Campaigning happens off-chain (Dash forum /
Discord).

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
