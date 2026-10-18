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

export function endDate(endsAtMs: number): string {
  return new Date(endsAtMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
