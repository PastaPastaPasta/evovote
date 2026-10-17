import { describeWriteError, type DescribedError } from '../voting/refusals';

/**
 * How a paid write ended. A write is only reported as done once it has been
 * read back from Platform; the SDK's own resolution is not taken as proof.
 *
 * - confirmed: read back
 * - refused: Platform refused it with a consensus code (a refusal in a block
 *   still pays its fees)
 * - unknown: no verdict (a timeout, a dropped connection) and the read-back
 *   did not find it; it may still land, so the user must check before retrying
 */
export type WriteOutcome<T = undefined> =
  | { status: 'confirmed'; value: T }
  | { status: 'refused'; error: DescribedError }
  | { status: 'unknown'; error?: DescribedError };

export interface SettleOptions {
  /** Read-back attempts after the write resolves (default 4). */
  attempts?: number;
  /** Pause between read-back attempts (default 2500 ms). */
  delayMs?: number;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `write`, then confirm it with `readBack` (which returns the confirmed
 * value, or undefined while it is not visible). A write that throws without
 * a consensus code is read back too: a timed-out broadcast may have landed.
 */
export async function settleWrite<W, T>(
  write: () => Promise<W>,
  readBack: (written: W | undefined) => Promise<T | undefined>,
  opts: SettleOptions = {},
): Promise<WriteOutcome<T>> {
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? 2500;
  let written: W | undefined;
  let failure: DescribedError | undefined;
  try {
    written = await write();
  } catch (e) {
    failure = describeWriteError(e);
    if (failure.code !== undefined) return { status: 'refused', error: failure };
  }
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await readBack(written);
      if (value !== undefined) return { status: 'confirmed', value };
    } catch {
      // A failed read is not a verdict; try again.
    }
    if (i < attempts - 1) await pause(delayMs);
  }
  return { status: 'unknown', error: failure };
}
