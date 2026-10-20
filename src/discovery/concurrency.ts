/**
 * A work queue with at most `concurrency` jobs in flight. Items can be pushed
 * while it runs (rows stream in); `cancel()` drops whatever has not started.
 */
export function createPump<T>(
  concurrency: number,
  worker: (item: T) => Promise<void>,
): { push(items: Iterable<T>): void; cancel(): void } {
  const queue: T[] = [];
  let active = 0;
  let cancelled = false;
  const pump = () => {
    while (!cancelled && active < concurrency && queue.length > 0) {
      const item = queue.shift() as T;
      active++;
      worker(item)
        .catch(() => {
          // Workers report their own failures; one must not stop the queue.
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return {
    push(items) {
      for (const item of items) queue.push(item);
      pump();
    },
    cancel() {
      cancelled = true;
      queue.length = 0;
    },
  };
}

/** Run `fn` over `items` with bounded concurrency; resolves when all settle. */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}

/**
 * A work queue whose waiting list is replaced wholesale: `want(items)` says
 * what is needed now, in priority order (rows on screen first), and anything
 * no longer wanted simply never starts. Jobs in flight finish. Each key runs
 * once per queue; `retry(key)` lets a failed one run again.
 */
export function createWantQueue<T>(
  concurrency: number,
  keyOf: (item: T) => string,
  worker: (item: T) => Promise<void>,
): { want(items: Iterable<T>): void; retry(key: string): void; cancel(): void } {
  let waiting: T[] = [];
  const started = new Set<string>();
  let active = 0;
  let cancelled = false;
  const pump = () => {
    while (!cancelled && active < concurrency && waiting.length > 0) {
      const item = waiting.shift() as T;
      const key = keyOf(item);
      if (started.has(key)) continue;
      started.add(key);
      active++;
      worker(item)
        .catch(() => {
          // Workers report their own failures; one must not stop the queue.
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return {
    want(items) {
      waiting = [...items].filter((item) => !started.has(keyOf(item)));
      pump();
    },
    retry(key) {
      started.delete(key);
    },
    cancel() {
      cancelled = true;
      waiting = [];
    },
  };
}
