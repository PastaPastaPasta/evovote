import { useEffect, useState } from 'react';

export type Route =
  | { page: 'home' }
  | { page: 'contest'; label: string }
  | { page: 'about' };

function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'about') return { page: 'about' };
  const contest = path.match(/^c\/(.+)$/);
  if (contest) {
    try {
      return { page: 'contest', label: decodeURIComponent(contest[1]) };
    } catch {
      // Malformed percent-encoding in a shared/typed URL: fall through home.
    }
  }
  return { page: 'home' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function contestHref(label: string): string {
  return `#/c/${encodeURIComponent(label)}`;
}
