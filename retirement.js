// EvoVote's old routes, mapped onto Governance. A contest ("#/c/<label>", "/c/<label>" or "/names/<label>") opens
// /names/<label> in DPNS's homograph-safe form (lower case, o to 0, i and l to 1), the address Governance publishes
// for each contest; anything else opens the contest list. A hash route wins; an ordinary fragment ("/c/Alice#votes")
// leaves the path to name the contest. <dashhq-moved> forwards at once and carries the network, the query, that
// fragment and the arrival notice. EvoVote kept its network in localStorage, not the URL, so a link without one opens
// the network this browser last used there.
(() => {
  const moved = document.querySelector('dashhq-moved');
  const query = new URLSearchParams(location.search);
  if (!query.has('network') && !query.has('net')) {
    try { if (localStorage.getItem('evovote.network') === 'testnet') moved.setAttribute('network', 'testnet'); } catch { /* mainnet */ }
  }
  for (const route of [location.hash.replace(/^#\/?/, ''), location.pathname.replace(/^\//, '')]) {
    if (/^about\/?$/.test(route)) {
      moved.setAttribute('path', '/names#name-contests-about');
      moved.setAttribute('label', 'How name contests work');
      return;
    }
    const match = /^(?:c|names)\/([^/?#]+)\/?$/.exec(route);
    if (!match) continue;
    let label = '';
    try { label = decodeURIComponent(match[1]).trim().replace(/\.dash$/i, '').toLowerCase(); } catch { /* the list */ }
    const key = label.replace(/o/g, '0').replace(/[il]/g, '1');
    if (!/^[a-z01][a-z01-]{1,17}[a-z01]$/.test(key)) return;
    moved.setAttribute('path', '/names/' + key);
    moved.setAttribute('label', `Open ${label}.dash in Governance`);
    return;
  }
})();
