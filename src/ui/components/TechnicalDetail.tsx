import type { ReactNode } from 'react';

/** Raw errors and codes, folded away under the plain-language message. */
export function TechnicalDetail({ children }: { children: ReactNode }) {
  return (
    <details className="technical">
      <summary>Technical detail</summary>
      <p className="mono">{children}</p>
    </details>
  );
}
