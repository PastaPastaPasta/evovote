/**
 * WASM SDK errors (WasmSdkError, WasmDppError) are wasm-bindgen objects, not
 * Error instances. They carry `message` and, for consensus refusals, a
 * numeric `code` (e.g. 40304); `code` is -1 when there is none.
 */

/** Read a property without letting a freed wasm object's getter throw. */
function safeGet(e: unknown, prop: 'message' | 'code'): unknown {
  if (!e || typeof e !== 'object') return undefined;
  try {
    return (e as Record<string, unknown>)[prop];
  } catch {
    return undefined;
  }
}

export function errorMessage(e: unknown): string {
  const message = safeGet(e, 'message');
  if (message !== undefined && message !== null && message !== '') {
    return String(message);
  }
  return String(e);
}

/**
 * The consensus error code of a refusal, when there is one: the `code`
 * property if it looks like a consensus code, else "code NNNNN" in the
 * message (older SDK paths only put it there). A bare number is not taken:
 * "timed out after 10000 ms" is not a refusal.
 */
export function errorCode(e: unknown): number | undefined {
  const code = safeGet(e, 'code');
  if (typeof code === 'number' && code >= 10000) return code;
  const match = errorMessage(e).match(/\bcode\W{0,3}([1-4]\d{4})\b/i);
  return match ? Number(match[1]) : undefined;
}
