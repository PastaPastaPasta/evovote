import { dateText } from '../model/text';

export { dateText, plural } from '../model/text';

/**
 * The site's one short-id format: the first and last six characters. Every
 * id shown in running text uses the default; the full id stays available
 * on hover (`title`) or through a copy button.
 */
export function shortId(id: string, chars = 6): string {
  return id.length <= chars * 2 + 1 ? id : `${id.slice(0, chars)}…${id.slice(-chars)}`;
}

export interface Countdown {
  text: string;
  urgent: boolean;
  past: boolean;
}

export function countdown(endsAtMs: number, now = Date.now()): Countdown {
  const delta = endsAtMs - now;
  if (delta <= 0) return { text: 'closing', urgent: true, past: true };
  const minutes = Math.floor(delta / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  let text: string;
  if (days > 0) text = `${days}d ${hours}h`;
  else if (hours > 0) text = `${hours}h ${mins}m`;
  else text = `${Math.max(mins, 1)}m`;
  return { text, urgent: delta < 24 * 3_600_000, past: false };
}

/** A contest's end (or any moment) in the site's date format. */
export function endDate(endsAtMs: number): string {
  return dateText(endsAtMs);
}


/** `text` cut to at most `max` characters at a word boundary, with an ellipsis when cut. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  // A single very long word is cut mid-word rather than dropped.
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * A title for free text: its first sentence (or line), at most `max`
 * characters. "Team A. We remove spam…" gives "Team A".
 */
export function firstSentence(text: string, max = 80): string {
  return excerpt(splitFirstSentence(text)[0].replace(/[.]$/, ''), max);
}

/** The text after its first sentence (what an excerpt under a `firstSentence` title shows). */
export function afterFirstSentence(text: string): string {
  return splitFirstSentence(text)[1];
}

function splitFirstSentence(text: string): [string, string] {
  const trimmed = text.trim();
  const line = trimmed.split(/\n/)[0].trim();
  const sentence = line.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? line;
  return [sentence, trimmed.slice(trimmed.indexOf(sentence) + sentence.length).trim()];
}
