import { useRef, useState } from 'react';
import { recoveryPhraseWarning } from '../../identity/phraseKeys';
import type { Network } from '../../sdk/network';

export type KeySource = 'phrase' | 'wif';

/** Whether the browser can mask a text input with CSS (EvoVote renders in the browser only, so this is read once). */
function cssMaskingSupported(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');
}

/** "Recovery phrase | Private key (WIF)": which one a key field takes. */
export function KeySourceToggle({
  value,
  onChange,
  disabled,
}: {
  value: KeySource;
  onChange: (next: KeySource) => void;
  disabled?: boolean;
}) {
  return (
    <div className="key-source" role="group" aria-label="Enter a recovery phrase or a private key">
      <button type="button" aria-pressed={value === 'phrase'} disabled={disabled} onClick={() => onChange('phrase')}>
        Recovery phrase
      </button>
      <button type="button" aria-pressed={value === 'wif'} disabled={disabled} onClick={() => onChange('wif')}>
        Private key (WIF)
      </button>
    </div>
  );
}

/**
 * A recovery-phrase field. Uncontrolled: the phrase is read from the input
 * when submitted and the input is cleared at once, so it never sits in React
 * state. `onSubmit` derives what it needs and drops the phrase.
 *
 * Masked with CSS (`-webkit-text-security`) on a text input where the browser
 * supports it, not with `type="password"`: browsers ignore `autocomplete` on
 * password fields and would offer to save the phrase to their (often synced)
 * password manager. Only where CSS masking is missing does it fall back to a
 * password field (adapted from Yappr's components/auth/recovery-phrase-form.tsx).
 */
export function RecoveryPhraseField({
  network,
  submitLabel,
  busyLabel = 'Checking…',
  onSubmit,
  onBusyChange,
}: {
  network: Network;
  submitLabel: string;
  busyLabel?: string;
  onSubmit: (phrase: string) => Promise<void>;
  /** Told when a submitted phrase starts and stops being checked (to lock the controls around it). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [hasText, setHasText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cssMasking] = useState(cssMaskingSupported);

  const submit = async () => {
    const input = field.current;
    const phrase = input?.value ?? '';
    if (!phrase.trim() || busy) return;
    if (input) input.value = '';
    setHasText(false);
    setBusy(true);
    onBusyChange?.(true);
    try {
      await onSubmit(phrase);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return (
    <>
      <div className="key-field">
        <input
          ref={field}
          type={cssMasking ? 'text' : 'password'}
          className="phrase-input"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          aria-label="Recovery phrase (12–24 words)"
          placeholder="Recovery phrase (12–24 words)"
          disabled={busy}
          onInput={(e) => setHasText(e.currentTarget.value.trim().length > 0)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit().catch(() => undefined);
          }}
        />
        <button type="button" className="vote-button" disabled={!hasText || busy} onClick={() => submit().catch(() => undefined)}>
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
      <p className="phrase-warning">{recoveryPhraseWarning(network)}</p>
    </>
  );
}
