/**
 * The site's Content-Security-Policy, added to the built index.html as a
 * `<meta http-equiv>` (GitHub Pages cannot send headers, so `frame-ancestors`
 * and reporting are out of reach). Build only: the dev server injects inline
 * scripts and styles of its own.
 *
 * - scripts: this origin, the WASM SDK (`wasm-unsafe-eval`), and the inline
 *   theme script by hash (computed from the built HTML, so editing it cannot
 *   silently break the page);
 * - workers: the SDK compiles its WASM in a `blob:` worker, off the main thread;
 * - connections: this origin and any https host (DAPI nodes are many IPs);
 * - styles and fonts: this origin and Google Fonts.
 *
 * The wallet sign-in keeps its keys in IndexedDB, usable by any script on
 * the page; this policy keeps foreign script off it.
 */
export function cspPolicy(scriptHashes: readonly string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${scriptHashes.map((h) => ` 'sha256-${h}'`).join('')}`,
    "worker-src 'self' blob:",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "connect-src 'self' https:",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `html` with the policy right after `<meta charset>` (else first in `<head>`), hashing every inline script. */
export async function withCsp(html: string): Promise<string> {
  const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const hashes = await Promise.all(inline.map(sha256Base64));
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspPolicy(hashes)}" />`;
  const anchor = /<meta charset="[^"]*"\s*\/?>/i.test(html) ? /<meta charset="[^"]*"\s*\/?>/i : /<head>/i;
  if (!anchor.test(html)) throw new Error('index.html has no <head> for the Content-Security-Policy');
  return html.replace(anchor, (tag) => `${tag}\n    ${meta}`);
}
