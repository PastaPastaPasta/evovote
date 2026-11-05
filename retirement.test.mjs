import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const script = readFileSync(new URL('./retirement.js', import.meta.url), 'utf8');

function visit(path) {
  const url = new URL(path, 'https://vote.dashhq.org');
  const elements = Object.fromEntries(['continue', 'forward-status', 'stay', 'destination'].map(id => [id, { dataset: {}, addEventListener(type, fn) { this[type] = fn; } }]));
  let pending, redirect;
  const events = {};
  const network = new URLSearchParams(url.search).get('network') || 'mainnet';
  runInNewContext(script, {
    location: { hash: url.hash, pathname: url.pathname, replace: href => { redirect = href; } },
    document: { getElementById: id => elements[id], querySelector: () => ({ setAttribute() {} }) },
    dashhq: { network: { canonicalize() {}, fromUrl: () => network, label: value => value }, href: (key, path, { network }) => `https://${key}.dashhq.org${path}?network=${network}` },
    addEventListener: (type, fn) => { events[type] = fn; },
    setTimeout: fn => { pending = fn; return 1; }, clearTimeout: () => { pending = null; },
  });
  return { elements, forward: () => { pending?.(); return redirect; }, events };
}

for (const route of ['/', '/#/about', '/#/', '/missing/page', '/about']) {
  test(`${route} forwards to the name-contest index`, () => {
    const state = visit(route);
    assert.equal(state.elements.continue.href, 'https://gov.dashhq.org/names?network=mainnet');
    assert.equal(state.forward(), state.elements.continue.href);
  });
}
for (const route of ['/?network=testnet#/c/alice', '/c/alice?network=testnet', '/names/alice?network=testnet']) {
  test(`${route} preserves the contest and network`, () => {
    assert.equal(visit(route).forward(), 'https://gov.dashhq.org/names/alice?network=testnet');
  });
}
test('labels are decoded and re-encoded as a single safe path segment', () => {
  assert.equal(visit('/?network=devnet-paloma#/c/a%2Fb').forward(), 'https://gov.dashhq.org/names/a%2Fb?network=devnet-paloma');
  assert.equal(visit('/#/c/%E0%A4%A').forward(), 'https://gov.dashhq.org/names?network=mainnet');
});
test('the visitor can pause forwarding and still follow the exact link', () => {
  const state = visit('/?network=testnet#/c/alice');
  state.elements.stay.click();
  assert.equal(state.forward(), undefined);
  assert.match(state.elements['forward-status'].textContent, /paused/);
  assert.equal(state.elements.continue.href, 'https://gov.dashhq.org/names/alice?network=testnet');
  state.events.hashchange();
  assert.equal(state.forward(), undefined);
});
test('unknown paths serve the same retirement page with absolute assets and strict CSP', () => {
  const index = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.equal(readFileSync(new URL('./404.html', import.meta.url), 'utf8'), index);
  assert.match(index, /script-src 'self'/);
  assert.doesNotMatch(index, /unsafe-|src="\.\//);
});
