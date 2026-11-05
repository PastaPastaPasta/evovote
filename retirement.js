(() => {
  dashhq.network.canonicalize();
  const moved = document.querySelector('dashhq-moved');
  function update() {
    const path = location.hash.replace(/^#\/?/, '') || location.pathname.replace(/^\//, '');
    const match = /^(?:c|names)\/([^/?#]+)\/?$/.exec(path);
    let label = '';
    try { label = match ? decodeURIComponent(match[1]) : ''; } catch {}
    const target = label ? '/names/' + encodeURIComponent(label) : '/names';
    moved.setAttribute('path', target + (new URLSearchParams(location.search).has('from') ? '' : '?from=vote'));
    moved.setAttribute('label', label ? `Open ${label} in Governance` : 'Open name contests');
  }
  addEventListener('hashchange', update);
  update();
})();
