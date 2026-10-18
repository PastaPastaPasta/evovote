import type { ReactNode } from 'react';

/** Routes that later work packages fill in. */
export function PlaceholderPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="about-page placeholder">
      <a href="#/" className="back-link">
        ← All contests
      </a>
      <h1>{title}</h1>
      {children}
    </div>
  );
}
