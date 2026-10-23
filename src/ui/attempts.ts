/**
 * Only the newest attempt's result counts. `start()` begins an attempt and
 * returns a check that stays true until another attempt starts or `cancel()`
 * runs (say, the user cleared the field or switched to another input while a
 * slow check was still out). Pure; one per component instance.
 */
export interface Attempts {
  start(): () => boolean;
  cancel(): void;
}

export function attempts(): Attempts {
  let latest = 0;
  return {
    start() {
      const mine = ++latest;
      return () => latest === mine;
    },
    cancel() {
      latest++;
    },
  };
}
