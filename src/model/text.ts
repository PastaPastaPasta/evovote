/** Plain-text formatting shared by the domain code and the UI. */

/**
 * The site's one date format: "Oct 19, 4:05 PM" (the year is added when it
 * is not this year). `time: false` gives the day alone, "Oct 19".
 */
export function dateText(ms: number, { time = true, now = Date.now() }: { time?: boolean; now?: number } = {}): string {
  const date = new Date(ms);
  const otherYear = date.getFullYear() !== new Date(now).getFullYear();
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(otherYear ? { year: 'numeric' } : {}),
    ...(time ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}

/**
 * The site's deadline format: a moment someone acts by or a vote closed at,
 * with the reader's time zone, "Oct 21, 4:05 PM EDT". Lists use `dateText`
 * without the time ("Oct 19").
 */
export function deadlineText(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const otherYear = date.getFullYear() !== new Date(now).getFullYear();
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(otherYear ? { year: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * The site's one short-id format: the first and last six characters. Every
 * id shown in running text uses the default; the full id stays available
 * on hover (`title`) or through a copy button.
 */
export function shortId(id: string, chars = 6): string {
  return id.length <= chars * 2 + 1 ? id : `${id.slice(0, chars)}…${id.slice(-chars)}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
