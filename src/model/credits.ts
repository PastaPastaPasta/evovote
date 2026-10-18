/** Platform credits: 1 DASH = 1e11 credits. */
export const CREDITS_PER_DASH = 100_000_000_000n;

/** "0.001482 DASH": credits as DASH, at most six decimals, trailing zeros dropped. */
export function dashText(credits: bigint): string {
  const negative = credits < 0n;
  const abs = negative ? -credits : credits;
  const whole = abs / CREDITS_PER_DASH;
  const frac = (abs % CREDITS_PER_DASH).toString().padStart(11, '0').slice(0, 6).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''} DASH`;
}
