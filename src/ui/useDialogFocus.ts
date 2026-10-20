import { useEffect, useRef, type RefObject } from 'react';

/** What Tab can land on. Hidden ones (display: none, closed <details>) are dropped at use. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** How long focus keeps looking for the opener's stand-in after a remount. */
const RESTORE_TRIES = 30;
const RESTORE_EVERY_MS = 100;

/**
 * Where Tab (or Shift+Tab, `back`) goes inside a dialog of `count` focusable
 * items when the focused one is at `index` (-1: the dialog itself, or
 * outside it): the index to focus, -1 for the dialog itself (nothing in it
 * is focusable), or undefined to let the browser move as usual. Only the
 * edges wrap, so the browser's own order holds inside. Pure.
 */
export function trapStep(count: number, index: number, back: boolean): number | undefined {
  if (count === 0) return -1;
  if (index < 0) return back ? count - 1 : 0;
  if (back && index === 0) return count - 1;
  if (!back && index === count - 1) return 0;
  return undefined;
}

/** Inside a closed <details> (other than its own summary): laid out by some browsers, but not focusable. */
function folded(el: HTMLElement): boolean {
  const closed = el.closest('details:not([open])');
  return closed !== null && !(el.tagName === 'SUMMARY' && el.parentElement === closed);
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0 && !folded(el),
  );
}

/**
 * Give focus back to whatever opened a dialog. If that element is gone (the
 * page behind remounted), its stand-in gets it once it renders: the one
 * element with identical markup (several identical ones, e.g. one "Vote for
 * this" per contender, could be any of them), else the main content. Never
 * while the user has put focus somewhere else.
 */
function restoreFocus(opener: HTMLElement): void {
  if (opener.isConnected) {
    opener.focus();
    return;
  }
  const html = opener.outerHTML;
  const unclaimed = () => document.activeElement === null || document.activeElement === document.body;
  let tries = 0;
  const attempt = () => {
    if (!unclaimed()) return;
    const twins = [...document.querySelectorAll<HTMLElement>(opener.tagName)].filter((el) => el.outerHTML === html);
    if (twins.length === 1) twins[0].focus();
    else if (twins.length === 0 && tries++ < RESTORE_TRIES) setTimeout(attempt, RESTORE_EVERY_MS);
    else document.getElementById('main')?.focus({ preventScroll: true });
  };
  attempt();
}

/**
 * A modal dialog's focus: moved in when it opens (to the element marked
 * `data-autofocus`, else the first focusable one), kept inside while Tab and
 * Shift+Tab cycle, Escape handed to `onEscape` (omit it while the dialog must
 * stay open), and returned to the opener when it closes.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onEscape?: () => void): void {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });
  // Kept across StrictMode's second run, which would otherwise find focus
  // already inside the dialog.
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !dialog.contains(active)) {
      opener.current ??= active;
    }
    const focusDialog = () => {
      if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
      dialog.focus();
    };
    const initial = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(dialog)[0];
    if (initial) initial.focus();
    else focusDialog();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (escape.current) {
          e.preventDefault();
          escape.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(dialog);
      // -1 for the dialog itself or anything outside it.
      const index = items.findIndex((el) => el === document.activeElement);
      const step = trapStep(items.length, index, e.shiftKey);
      if (step === undefined) return;
      e.preventDefault();
      if (step < 0) focusDialog();
      else items[step].focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener.current) restoreFocus(opener.current);
    };
  }, [ref]);
}
