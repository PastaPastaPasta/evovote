// The same file in vote, fees and basics. The shell's <dashhq-moved> forwards at once and owns the network, the query
// and the arrival notice (checked in design/tools/render-demo.mjs); a retired site keeps its pages and its route map.
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const html = read('./index.html');
const site = /<dashhq-moved product="([^"]+)"/.exec(html)[1];
const fallback = site === 'fees' ? './public/404.html' : './404.html';
const pages = ['./index.html', fallback, ...(site === 'basics' ? ['./get-identities/index.html', './all-dpns/index.html'] : [])];
const script = existsSync(new URL('./retirement.js', import.meta.url)) ? read('./retirement.js') : '';
const home = { vote: 'https://gov.dashhq.org', fees: 'https://explorer.dashhq.org', basics: 'https://explorer.dashhq.org' }[site];

// Run the route map against an old address and return what it leaves on <dashhq-moved>.
function visit(route, page = html, stored) {
  const attr = (k) => (new RegExp(`<dashhq-moved[^>]+ ${k}="([^"]+)"`).exec(page) || [])[1];
  const attrs = { path: attr('path'), label: attr('label') };
  runInNewContext(script, { URLSearchParams, location: new URL(route, `https://${site}.dashhq.org`),
    ...(stored && { localStorage: { getItem: (k) => stored[k] ?? null } }),
    document: { querySelector: () => ({ setAttribute: (k, v) => { attrs[k] = v; } }) } });
  return attrs;
}

if (site === 'vote') {
  for (const route of ['/?network=testnet#/c/alice', '/c/alice?network=testnet', '/names/Alice', '/#/c/alice.dash']) {
    test(`${route} opens the contest at the address Governance publishes`, () => {
      assert.deepEqual(visit(route), { path: '/names/a11ce', label: 'Open alice.dash in Governance' });
    });
  }
  test('legacy About links open the name-contest explanation', () => {
    for (const route of ['/#/about', '/about', '/about/']) {
      assert.deepEqual(visit(route), { path: '/names#name-contests-about', label: 'How name contests work' });
    }
  });
  test('an ordinary fragment leaves the path to name the contest', () => {
    for (const route of ['/c/Alice#votes', '/names/alice#votes']) {
      assert.deepEqual(visit(route), { path: '/names/a11ce', label: 'Open alice.dash in Governance' }, route);
    }
    assert.deepEqual(visit('/about#votes'), { path: '/names#name-contests-about', label: 'How name contests work' });
  });
  test('a label with a leading or trailing hyphen opens the contest list', () => {
    for (const route of ['/c/-alice', '/#/c/alice-', '/names/-ab-']) {
      assert.deepEqual(visit(route), { path: '/names', label: 'Open name contests' }, route);
    }
    assert.equal(visit('/#/c/a-b').path, '/names/a-b');
  });
  test('a link without a network opens the network EvoVote last used in this browser', () => {
    const testnet = { 'evovote.network': 'testnet' };
    assert.equal(visit('/#/c/alice', html, testnet).network, 'testnet');
    assert.equal(visit('/', html, testnet).network, 'testnet');
    assert.equal(visit('/#/c/alice', html, { 'evovote.network': 'mainnet' }).network, undefined);
    assert.equal(visit('/?network=mainnet#/c/alice', html, testnet).network, undefined);
    assert.equal(visit('/?net=main#/c/alice', html, testnet).network, undefined);
    assert.equal(visit('/#/c/alice').network, undefined);
  });
  test('anything that is not a contest label opens the contest list', () => {
    for (const route of ['/#/c/a%2Fb', '/#/c/%E0%A4%A', '/#/c/ab', '/missing/page']) {
      assert.deepEqual(visit(route), { path: '/names', label: 'Open name contests' }, route);
    }
  });
}
if (site === 'basics') {
  test('old list pages open username search', () => {
    for (const page of ['./get-identities/index.html', './all-dpns/index.html']) {
      assert.equal(visit('/?network=testnet#names', read(page)).path, '/dpns/search/', page);
    }
  });
  test('identity and name parameters open their record', () => {
    assert.equal(visit('/?id=public-id&network=testnet').path, '/identity/');
    assert.equal(visit('/?name=alice.dash').path, '/dpns/');
  });
}
if (site === 'fees') test('every old address opens the fee estimator in Explorer', () => {
  for (const route of ['/?contract=example#costs', '/old/calculator?network=testnet#costs']) assert.equal(visit(route).path, '/tools/fees/');
});

test('the shell owns the forward: the site writes no timer and no redirect of its own', () => {
  assert.match(html, /<dashhq-moved /);
  assert.doesNotMatch(script, /setTimeout|setInterval|location\.(replace|assign|href\s*=)/);
});
test('unknown routes serve the same page', () => assert.equal(read(fallback), html));
for (const page of pages) {
  test(`${page} works without JavaScript and has no network menu`, () => {
    const p = read(page);
    assert.doesNotMatch(/<dashhq-bar[^>]*>/.exec(p)[0], /networks=/);
    const link = /<dashhq-moved[\s\S]*?<a class="dh-btn dh-btn--primary" href="([^"]+)"/.exec(p);
    assert.ok(link, 'a primary link inside <dashhq-moved>');
    const u = new URL(link[1].replaceAll('&amp;', '&'));
    assert.equal(u.origin, home);
    assert.equal(u.searchParams.get('moved-from'), site);
    assert.ok(u.searchParams.get('network'));
    assert.match(p, /<h1 class="dh-page-header__title">/);
    assert.match(p, /<noscript>/);
    assert.match(p, /script-src 'self'/);
    assert.doesNotMatch(p, /unsafe-|src="\.\//);
  });
}
