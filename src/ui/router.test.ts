import { describe, expect, it } from 'vitest';
import { dpnsKeyString } from '../kinds/dpns';
import { resolveNetwork } from '../sdk/network';
import { isContractIdLike, navSection, parseRoute, sameView } from './router';

const CONTRACT = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

describe('parseRoute', () => {
  it('should parse the fixed routes', () => {
    expect(parseRoute('')).toEqual({ page: 'home' });
    expect(parseRoute('#/')).toEqual({ page: 'home' });
    expect(parseRoute('#/about')).toEqual({ page: 'about' });
    expect(parseRoute('#/mn')).toEqual({ page: 'mn' });
    expect(parseRoute('#/me')).toEqual({ page: 'me' });
  });

  it('should parse kinds, rejecting unknown ones', () => {
    expect(parseRoute('#/k/dpns')).toEqual({ page: 'kind', kind: 'dpns' });
    expect(parseRoute('#/k/charter')).toEqual({ page: 'kind', kind: 'charter' });
    expect(parseRoute('#/k/nope').page).toBe('notFound');
  });

  it('should keep canonical poll keys as they are', () => {
    const key = dpnsKeyString('alice');
    expect(parseRoute(`#/p/${key}`)).toEqual({ page: 'poll', keyString: key });
  });

  it('should canonicalize equivalent spellings of a poll key, and pass bad ones through', () => {
    const key = dpnsKeyString('alice');
    const [contract, type, index] = key.split('/');
    // Same values, extra JSON whitespace, and a needlessly escaped segment.
    const spaced = btoa('[ "dash", "alice" ]').replace(/=+$/, '');
    const variant = `${contract}/${encodeURIComponent(type).replace('d', '%64')}/${index}/${spaced}`;
    expect(parseRoute(`#/p/${variant}`)).toEqual({ page: 'poll', keyString: key, redirect: true });
    expect(parseRoute('#/p/garbage')).toEqual({ page: 'poll', keyString: 'garbage' });
  });

  it('should redirect v1 username links to the DPNS poll key, normalized', () => {
    expect(parseRoute('#/c/ther0adn0ttaken')).toEqual({
      page: 'poll',
      keyString: dpnsKeyString('ther0adn0ttaken'),
      redirect: true,
    });
    expect(parseRoute('#/c/TheRoadNotTaken')).toMatchObject({
      keyString: dpnsKeyString('ther0adn0ttaken'),
    });
    expect(parseRoute('#/c/%E0%A4%A').page).toBe('notFound');
  });

  it('should send a 43–44 char base58 id to the contract browser', () => {
    expect(parseRoute(`#/c/${CONTRACT}`)).toEqual({ page: 'contract', contractId: CONTRACT });
  });

  it('should parse moderated contract routes', () => {
    expect(parseRoute('#/m')).toEqual({ page: 'moderatedDirectory' });
    expect(parseRoute(`#/m/${CONTRACT}`)).toEqual({ page: 'moderated', target: CONTRACT });
    expect(parseRoute(`#/m/${CONTRACT}/charter/abc`)).toEqual({
      page: 'moderated',
      target: CONTRACT,
      charterId: 'abc',
    });
  });

  it('should report unknown paths', () => {
    expect(parseRoute('#/zzz')).toEqual({ page: 'notFound', path: 'zzz' });
  });
});

describe('isContractIdLike', () => {
  it('should accept 32-byte base58 ids only', () => {
    expect(isContractIdLike(CONTRACT)).toBe(true);
    expect(isContractIdLike('alice')).toBe(false);
    expect(isContractIdLike('1'.repeat(44))).toBe(false); // decodes to 44 zero bytes
    expect(isContractIdLike(`${CONTRACT.slice(0, 42)}0O`)).toBe(false);
  });
});

describe('resolveNetwork', () => {
  it('should prefer ?network=, then storage, then testnet', () => {
    expect(resolveNetwork('?network=mainnet', 'testnet')).toBe('mainnet');
    expect(resolveNetwork('', 'mainnet')).toBe('mainnet');
    expect(resolveNetwork('', null)).toBe('testnet');
    expect(resolveNetwork('?network=bogus', 'nonsense')).toBe('testnet');
  });
});

describe('navSection and sameView', () => {
  it('should map routes to header sections', () => {
    expect(navSection(parseRoute('#/'))).toBe('contests');
    expect(navSection(parseRoute(`#/c/${CONTRACT}`))).toBe('contests');
    expect(navSection(parseRoute(`#/m/${CONTRACT}/charter/abc`))).toBe('moderation');
    expect(navSection(parseRoute('#/about'))).toBe('about');
    expect(navSection(parseRoute('#/me'))).toBe('me');
  });

  it('should keep the view for list tab switches only', () => {
    expect(sameView(parseRoute('#/'), parseRoute('#/k/dpns'))).toBe(true);
    expect(sameView(parseRoute('#/m'), parseRoute(`#/m/${CONTRACT}`))).toBe(false);
    expect(sameView(parseRoute(`#/m/${CONTRACT}`), parseRoute(`#/m/${CONTRACT}`))).toBe(true);
    expect(sameView(parseRoute('#/about'), parseRoute('#/me'))).toBe(false);
  });
});
