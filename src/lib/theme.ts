import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'evovote.theme';

function storedPref(): ThemePref {
  const value = localStorage.getItem(KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

function resolve(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(pref: ThemePref): void {
  document.documentElement.setAttribute('data-theme', resolve(pref));
}

/**
 * Theme preference with system detection. An inline script in index.html
 * applies the stored preference before first paint; this hook keeps it live
 * (OS appearance changes while in system mode) and drives the toggle.
 */
export function useTheme(): { pref: ThemePref; cycle: () => void } {
  const [pref, setPref] = useState<ThemePref>(storedPref);

  useEffect(() => {
    apply(pref);
    if (pref !== 'system') return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [pref]);

  const cycle = () => {
    setPref((prev) => {
      const next: ThemePref =
        prev === 'system' ? 'light' : prev === 'light' ? 'dark' : 'system';
      localStorage.setItem(KEY, next);
      return next;
    });
  };

  return { pref, cycle };
}
