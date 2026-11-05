import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const site = /<dashhq-moved product="([^"]+)"/.exec(html)[1];
const script = site === 'fees' ? '' : readFileSync(new URL(site === 'fees' ? './public/retirement.js' : './retirement.js', import.meta.url), 'utf8');
function visit(route, path) {
  const url = new URL(route, `https://${site}.dashhq.org`);
  const attrs = { path: path || /<dashhq-moved[^>]+path="([^"]+)"/.exec(html)[1] };
  const events = {};
  runInNewContext(script, { URLSearchParams, location: url, dashhq: { network: { canonicalize() {} } },
    document: { querySelector: () => ({ setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k] }) },
    addEventListener: (k, v) => { events[k] = v; } });
  return { attrs, events, url };
}
if (site === 'vote') {
  for (const route of ['/?network=testnet#/c/alice', '/c/alice?network=testnet', '/names/alice?network=testnet']) test(`${route} preserves the selected contest`, () => {
    const { attrs } = visit(route);assert.equal(attrs.path, '/names/alice?from=vote');assert.equal(attrs.label, 'Open alice in Governance');
  });
  test('labels remain one encoded segment; bad escapes and unknown routes go to index', () => {
    assert.equal(visit('/#/c/a%2Fb').attrs.path, '/names/a%2Fb?from=vote');
    for (const path of ['/#/c/%E0%A4%A', '/missing/page', '/#/about']) assert.equal(visit(path).attrs.path, '/names?from=vote');
  });
  test('changing an old hash updates the destination and existing arrival parameters survive', () => {
    const state = visit('/?from=wallet#/c/alice');assert.equal(state.attrs.path, '/names/alice');
    state.url.hash = '#/c/bob';state.events.hashchange();assert.equal(state.attrs.path, '/names/bob');
  });
}
if (site === 'basics') {
  test('old list routes retain the relevant replacement', () => {
    assert.equal(visit('/get-identities/?network=testnet#names', '/dpns/search/').attrs.path, '/dpns/search/');
    assert.equal(visit('/all-dpns/', '/dpns/search/').attrs.path, '/dpns/search/');
  });
  test('identity and name parameters select their entity view', () => {
    assert.equal(visit('/?id=public-id&network=testnet').attrs.path, '/identity/');
    assert.equal(visit('/?name=alice.dash').attrs.path, '/dpns/');
  });
}
if (site === 'fees') test('root and obsolete paths use Explorer fees', () => {
  for (const path of ['/?contract=example#costs', '/old/calculator?network=testnet#costs']) assert.equal(visit(path).attrs.path, '/tools/fees/');
});
test('the shared component owns the countdown and retirement policy', () => {
  assert.match(html, /<dashhq-moved /);assert.doesNotMatch(script, /setTimeout|setInterval|location.replace/);
});
test('root and unknown routes share strict CSP, absolute assets and a no-script link', () => {
  const fallback = readFileSync(new URL(site === 'fees' ? './public/404.html' : './404.html', import.meta.url), 'utf8');
  assert.equal(fallback, html);assert.match(html, /script-src 'self'/);assert.doesNotMatch(html, /unsafe-|src="\.\//);assert.match(html, /<noscript>/);
});
