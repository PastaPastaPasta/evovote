// EvoVote's old routes, mapped onto Governance. A contest ("#/c/<label>", "/c/<label>" or "/names/<label>") opens
// /names/<label> in DPNS's homograph-safe form (lower case, o to 0, i and l to 1), the address Governance publishes
// for each contest; anything else opens the contest list. <dashhq-moved> forwards at once and carries the network,
// the query and the arrival notice.
(() => {
  const moved = document.querySelector('dashhq-moved');
  const route = location.hash.replace(/^#\/?/, '') || location.pathname.replace(/^\//, '');
  if (/^about\/?$/.test(route)) {
    moved.setAttribute('path', '/names#name-contests-about');
    moved.setAttribute('label', 'How name contests work');
    return;
  }
  const match = /^(?:c|names)\/([^/?#]+)\/?$/.exec(route);
  let label = '';
  try { label = match ? decodeURIComponent(match[1]).trim().replace(/\.dash$/i, '').toLowerCase() : ''; } catch { /* the list */ }
  const key = label.replace(/o/g, '0').replace(/[il]/g, '1');
  if (!/^[a-z01-]{3,19}$/.test(key)) return;
  moved.setAttribute('path', '/names/' + key);
  moved.setAttribute('label', `Open ${label}.dash in Governance`);
})();
