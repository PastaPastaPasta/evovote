import { useEffect, useState } from 'react';
import { base58Decode } from '../model/bytes';
import { decodePollKey, encodePollKey } from '../model/pollKey';
import { dpnsKeyString, normalizeDpnsLabel } from '../kinds/dpns';
import { isKindId } from '../kinds/registry';
import type { KindId } from '../kinds/types';

/**
 * Hash routes (design §4.1):
 *
 *   #/                         overview of every kind
 *   #/k/<kind>                 the list for one kind (dpns | charter | generic)
 *   #/p/<pollKey>              one contest (canonical PollKey string)
 *   #/m                        moderated-contract directory
 *   #/m/<target>[/charter/<id>] moderator election hub / proposal
 *   #/c/<contractId>           generic browser for one contract     (WP5)
 *   #/c/<label>                v1 link: redirects to the DPNS poll key
 *   #/mn                       masternode keyring
 *   #/me                       identity session
 *   #/about
 *
 * `#/c/<x>` is shared by v1 username links and the contract browser. A
 * base58 string of 43–44 characters that decodes to 32 bytes is a contract
 * id; anything else is a DPNS label. Contested DPNS labels are 3–19
 * characters (the index's fieldMatches), so no v1 link can be mistaken for
 * a contract id.
 */
export type Route =
  | { page: 'home' }
  | { page: 'kind'; kind: KindId }
  | { page: 'poll'; keyString: string; redirect?: boolean }
  | { page: 'moderatedDirectory' }
  | { page: 'moderated'; target: string; charterId?: string }
  | { page: 'contract'; contractId: string }
  | { page: 'mn' }
  | { page: 'me' }
  | { page: 'about' }
  | { page: 'notFound'; path: string };

export function isContractIdLike(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding in a shared or typed URL.
    return undefined;
  }
}

/** Pure; exported for tests. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === '') return { page: 'home' };
  if (path === 'about') return { page: 'about' };
  if (path === 'mn') return { page: 'mn' };
  if (path === 'me') return { page: 'me' };
  if (path === 'm') return { page: 'moderatedDirectory' };

  const kind = path.match(/^k\/([^/]+)$/);
  if (kind) {
    return isKindId(kind[1]) ? { page: 'kind', kind: kind[1] } : { page: 'notFound', path };
  }

  // Many spellings decode to the same poll (escapes, base64 padding bits,
  // JSON whitespace). Everything downstream (live polls, current votes,
  // receipts) is keyed by the canonical string, so re-encode and redirect.
  // An undecodable key is passed through for the page to reject.
  const poll = path.match(/^p\/(.+)$/);
  if (poll) {
    const key = decodePollKey(poll[1]);
    if (!key) return { page: 'poll', keyString: poll[1] };
    const canonical = encodePollKey(key);
    return canonical === poll[1]
      ? { page: 'poll', keyString: canonical }
      : { page: 'poll', keyString: canonical, redirect: true };
  }

  const moderated = path.match(/^m\/([^/]+)(?:\/charter\/([^/]+))?$/);
  if (moderated) {
    return { page: 'moderated', target: moderated[1], charterId: moderated[2] };
  }

  const c = path.match(/^c\/(.+)$/);
  if (c) {
    const value = decode(c[1]);
    if (value === undefined || value === '') return { page: 'notFound', path };
    if (isContractIdLike(value)) return { page: 'contract', contractId: value };
    return { page: 'poll', keyString: dpnsKeyString(normalizeDpnsLabel(value)), redirect: true };
  }

  return { page: 'notFound', path };
}

export function pollHref(keyString: string): string {
  return `#/p/${keyString}`;
}

export function kindHref(kind: KindId): string {
  return `#/k/${kind}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  useEffect(() => {
    // v1 links land on the canonical URL without adding a history entry.
    if (route.page === 'poll' && route.redirect) {
      history.replaceState(null, '', pollHref(route.keyString));
    }
  }, [route]);
  return route;
}
