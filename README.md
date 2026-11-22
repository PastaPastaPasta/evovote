# EvoVote retirement

Name contests now live in [Governance](https://gov.dashhq.org/names).
The former application is retained in git history only. This dependency-free site
serves a moved page for the root, legacy hash routes and unknown paths via `404.html`.
The shared shell's `<dashhq-moved>` forwards at once: a contest (`#/c/<label>`,
`/c/<label>`, `/names/<label>`) opens Governance's canonical `/names/<label>` (lower
case, o to 0, i and l to 1), anything else the contest list. The network and query
travel, and Governance says once that vote.dashhq.org is now part of it. Without
JavaScript the page shows one link to the contest list. No keys are read or stored.

Run `npm ci`, `npm test`, `npm run lint` and `npm run build`. The static export is
`dist/`, with same-origin scripts, fonts and styles under a strict CSP.
