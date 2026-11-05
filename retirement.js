(() => {
  const link = document.getElementById('continue');
  const status = document.getElementById('forward-status');
  const stay = document.getElementById('stay');
  const bar = document.querySelector('dashhq-bar');
  let timer;
  let paused = false;

  function update() {
    clearTimeout(timer);
    dashhq.network.canonicalize();
    const network = dashhq.network.fromUrl();
    bar.setAttribute('network', network);
    const path = location.hash.replace(/^#\/?/, '') || location.pathname.replace(/^\//, '');
    const match = /^(?:c|names)\/([^/?#]+)\/?$/.exec(path);
    let label = '';
    try { label = match ? decodeURIComponent(match[1]) : ''; } catch {}
    const target = label ? '/names/' + encodeURIComponent(label) : '/names';
    const arrivalPath = target + '?from=vote';
    link.dataset.path = arrivalPath;
    link.href = dashhq.href('gov', arrivalPath, { network });
    link.textContent = label ? 'Open ' + label + ' in Governance →' : 'Open name contests →';
    document.getElementById('destination').textContent = label
      ? 'Your contest bookmark will open on ' + dashhq.network.label(network) + '.'
      : 'Browse name contests on ' + dashhq.network.label(network) + '.';
    if (!paused) timer = setTimeout(() => location.replace(link.href), 10000);
  }

  stay.addEventListener('click', () => {
    clearTimeout(timer);
    paused = true;
    status.textContent = 'Automatic forwarding paused. Continue when you are ready.';
    stay.hidden = true;
  });
  addEventListener('hashchange', update);
  update();
})();
