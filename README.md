# EvoVote retirement

Name contests now live in [Governance](https://gov.dashhq.org/names).
The former application is retained in git history only. This dependency-free site
serves a moved page for the root, legacy hash routes and unknown paths via `404.html`.
Contest labels and the explicit network travel to Governance. A visible link works
immediately; a ten-second automatic forward can be paused. No keys are read or stored.

Run `npm ci`, `npm test`, `npm run lint` and `npm run build`. The static export is
`dist/`, with same-origin scripts, fonts and styles under a strict CSP.
