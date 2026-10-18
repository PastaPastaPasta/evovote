import { useState, type FormEvent } from 'react';
import type { Network } from '../../sdk/network';
import { shortId } from '../format';
import { loadRecentContracts } from '../recentContracts';
import { isContractIdLike } from '../router';

/** Open the contested-index browser for any contract id, with recently opened ones listed. */
export function OpenContractForm({ network }: { network: Network }) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [recent] = useState(() => loadRecentContracts(network));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = value.trim();
    if (!isContractIdLike(id)) {
      setInvalid(true);
      return;
    }
    location.hash = `#/c/${id}`;
  };

  return (
    <section className="open-contract" aria-label="Open a contract">
      <form onSubmit={submit}>
        <label className="mono-label" htmlFor="open-contract-id">
          Browse any contract’s contested indices
        </label>
        <div className="open-contract-row">
          <input
            id="open-contract-id"
            className="search"
            type="text"
            placeholder="Data contract id (base58)"
            value={value}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid(false);
            }}
          />
          <button type="submit" className="vote-button ghost">
            Open
          </button>
        </div>
        {invalid && (
          <p className="mono-label error" role="alert">
            A contract id is 43–44 base58 characters.
          </p>
        )}
      </form>
      {recent.length > 0 && (
        <p className="mono-label recent-contracts">
          recent:{' '}
          {recent.map((id) => (
            <a key={id} className="mono" href={`#/c/${id}`} title={id}>
              {shortId(id, 6)}
            </a>
          ))}
        </p>
      )}
    </section>
  );
}
