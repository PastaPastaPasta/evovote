import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../sdk/errors';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string };

const sameDeps = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * Run `load` on mount and whenever `deps` change; `reload()` runs it again.
 * Until the run for the current inputs settles the state is `loading`; a
 * result for other inputs is never shown. A `reload()` keeps showing the
 * last result (with `refreshing`) so forms below it keep their state.
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> & { reload: () => void; refreshing: boolean } {
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<{ deps: readonly unknown[]; round: number; state: AsyncState<T> }>();
  useEffect(() => {
    let cancelled = false;
    const settle = (state: AsyncState<T>) => {
      if (!cancelled) setResult({ deps, round, state });
    };
    load().then(
      (value) => settle({ status: 'ok', value }),
      (e: unknown) => settle({ status: 'error', message: errorMessage(e) }),
    );
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure every render; `deps` says when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  const sameInputs = result !== undefined && sameDeps(result.deps, deps);
  const refreshing = sameInputs && result.round !== round;
  return { ...(sameInputs ? result.state : { status: 'loading' }), reload, refreshing };
}
