import { useEffect, useRef, useState } from 'react';

const SAID = { idle: '', copied: 'Copied', failed: 'Copy failed' } as const;

/**
 * An icon button that copies `text` to the clipboard. `label` names what is
 * copied ("Copy identity id"); after a click the icon turns into a tick (or a
 * cross) for a moment and a screen reader hears "Copied" (or "Copy failed").
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    // navigator.clipboard is missing outside secure contexts (plain http).
    (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'))).then(
      () => setState('copied'),
      () => setState('failed'),
    );
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };

  const said = SAID[state];
  return (
    <button
      type="button"
      className={`copy-button${state === 'idle' ? '' : ` ${state}`}`}
      onClick={copy}
      aria-label={label}
      title={said || label}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true" focusable="false">
        {state === 'idle' ? (
          <>
            <rect x="5.5" y="5.5" width="8" height="8.5" rx="1.6" strokeWidth="1.4" />
            <path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v6.5A1.5 1.5 0 0 0 4 11h.5" strokeWidth="1.4" />
          </>
        ) : (
          <path
            d={state === 'copied' ? 'M3 8.5l3.2 3L13 4.5' : 'M4 4l8 8M12 4l-8 8'}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      <span className="visually-hidden" aria-live="polite">
        {said}
      </span>
    </button>
  );
}
