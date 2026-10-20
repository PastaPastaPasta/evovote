import type { ReactNode } from 'react';

/** Routes that later work packages fill in. */
export function PlaceholderPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="about-page placeholder">
      <header className="page-header">
        <a href="#/" className="back-link">
          ← All contests
        </a>
        <h1 className="page-title">{title}</h1>
      </header>
      {children}
    </div>
  );
}
