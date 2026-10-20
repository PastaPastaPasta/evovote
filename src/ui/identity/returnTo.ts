/**
 * Back to where the user was after signing in. Whenever the app navigates to
 * `#/me` from another page (the header link, "Sign in to comment", a charter
 * page), that page's hash is remembered for this tab; a sign-in on `#/me`
 * then returns there. Opening `#/me` directly remembers nothing, so the user
 * stays on their identity page.
 */
const RETURN_KEY = 'evovote.signin.return';
const ME = '#/me';

function storage(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Remember `hash` as the place to return to (ignored for `#/me` itself and non-routes). */
export function rememberReturn(hash: string): void {
  if (!hash.startsWith('#/') || hash === ME || hash.startsWith(`${ME}?`)) return;
  try {
    storage()?.setItem(RETURN_KEY, hash);
  } catch {
    // Storage full or blocked: the user simply stays on #/me.
  }
}

/** The remembered page, once (it is forgotten as it is read). */
export function takeReturn(): string | null {
  const store = storage();
  const hash = store?.getItem(RETURN_KEY) ?? null;
  store?.removeItem(RETURN_KEY);
  return hash;
}

/** Forget the remembered page (the user left `#/me` without signing in). */
export function forgetReturn(): void {
  storage()?.removeItem(RETURN_KEY);
}

/** After a sign-in on `#/me`: go back to the remembered page, if any. */
export function returnAfterSignIn(win: Window = window): void {
  if (win.location.hash !== ME) return;
  const hash = takeReturn();
  if (hash) win.location.hash = hash;
}

/** Track navigations into `#/me` (call once at startup). */
export function installReturnTracking(win: Window = window): void {
  win.addEventListener('hashchange', (event: HashChangeEvent) => {
    const to = new URL(event.newURL).hash;
    const from = new URL(event.oldURL).hash;
    if (to === ME && from !== ME) {
      if (from) rememberReturn(from);
      else forgetReturn();
    }
  });
}
