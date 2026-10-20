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

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
