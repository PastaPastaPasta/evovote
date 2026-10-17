import { useEffect, useRef, useState } from 'react';

/** Copies `text` to the clipboard; says "copied" for a moment, or "failed". */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setState('copied'),
      () => setState('failed'),
    );
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };

  return (
    <button type="button" className="link-button copy-button" onClick={copy} aria-label={label}>
      {state === 'copied' ? 'copied' : state === 'failed' ? 'copy failed' : 'copy'}
    </button>
  );
}
