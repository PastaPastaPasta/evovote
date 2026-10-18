/**
 * Free a wasm-bindgen object, ignoring one that is already freed (or moved
 * into the SDK). Accepts anything so call sites can pass optional values.
 */
export function freeQuietly(obj: unknown): void {
  try {
    (obj as { free?: () => void } | null | undefined)?.free?.();
  } catch {
    // Already freed.
  }
}
