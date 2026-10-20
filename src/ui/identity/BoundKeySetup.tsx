import { useState } from 'react';
import type { WriteCost } from '../../charters/writes';
import {
  addBoundKey,
  existingBoundKey,
  generateKey,
  IDENTITY_UPDATE_FEE_ESTIMATE,
  importPrivateKeyFor,
  type BoundKeySpec,
  type GeneratedKey,
} from '../../identity/update';
import { heldPrivateKeyFor, holdPrivateKey, type IdentitySession } from '../../identity/session';
import type { SdkHandle } from '../../sdk/connection';
import { shortId } from '../format';
import { PaidWrite } from '../charters/PaidWrite';

/** The backup file's name, also shown when the key is asked for again. */
function backupFileName(spec: BoundKeySpec, identityId: string): string {
  return `evovote-${spec.purpose.toLowerCase()}-key-${identityId.slice(0, 8)}.txt`;
}

function downloadBackup(key: GeneratedKey, spec: BoundKeySpec, identityId: string): void {
  const text = [
    `EvoVote ${spec.purpose.toLowerCase()} key backup`,
    `identity: ${identityId}`,
    `bound to: ${spec.contractId} / ${spec.documentTypeName}`,
    `public key: ${key.publicKeyHex}`,
    `private key (WIF): ${key.wif}`,
    '',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFileName(spec, identityId);
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Make sure the session holds a contract-bound key: the leader's DECRYPTION
 * key bound to `submittedCharter`, or a member's ENCRYPTION key bound to
 * `joinRequest`.
 *
 * - On chain and loaded: nothing to do.
 * - On chain, not loaded: paste its private key (checked against the chain).
 * - Missing: generate one here, have the user back it up, then add it with
 *   an identity update signed by the master key, asked for now and dropped.
 */
export function BoundKeySetup({
  handle,
  session,
  spec,
  what,
}: {
  handle: SdkHandle;
  session: IdentitySession;
  spec: BoundKeySpec;
  /** "decryption key for join requests". */
  what: string;
}) {
  const onChain = existingBoundKey(session.keys, spec);
  const [importWif, setImportWif] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedKey | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [masterWif, setMasterWif] = useState('');
  const [revealed, setRevealed] = useState(false);

  if (onChain && heldPrivateKeyFor(onChain)) {
    return (
      <p className="page-note ok">
        Your {what} (key #{onChain.keyId}) is loaded for this session.
      </p>
    );
  }

  if (onChain) {
    const load = () => {
      const result = importPrivateKeyFor(handle.mod, handle.network, importWif, onChain);
      setImportWif('');
      if (!result.ok) setImportError(result.error);
      else {
        setImportError(null);
        holdPrivateKey(result.key.hash160, result.key.privateKeyHex);
      }
    };
    return (
      <div className="bound-key">
        <p>
          Your identity has a {what} (key #{onChain.keyId}). Paste its private key to use it in this session. If
          EvoVote created it and you downloaded the backup, it is in{' '}
          <span className="mono">{backupFileName(spec, session.identityId)}</span>.
        </p>
        <div className="key-field">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`Private key of key #${onChain.keyId} (WIF)`}
            placeholder="Private key (WIF)"
            value={importWif}
            onChange={(e) => setImportWif(e.target.value)}
          />
          <button className="vote-button ghost" disabled={!importWif.trim()} onClick={load}>
            Load key
          </button>
        </div>
        {importError && <p className="meta error">{importError}</p>}
      </div>
    );
  }

  if (!generated) {
    return (
      <div className="bound-key">
        <p>
          Your identity has no {what} yet. EvoVote can create one in your browser and add it to your identity.
          Signing in never needs your master key, but adding a key does: you paste it once to sign this one update,
          and it is dropped right after.
        </p>
        <button
          className="vote-button ghost"
          onClick={() => {
            const key = generateKey(handle.mod, handle.network);
            // Held at once, so the key is not lost if the update's outcome is unclear.
            holdPrivateKey(key.hash160, key.privateKeyHex);
            setGenerated(key);
          }}
        >
          Create a new key
        </button>
      </div>
    );
  }

  const estimate = async (): Promise<WriteCost> => ({
    fees: IDENTITY_UPDATE_FEE_ESTIMATE,
    contestFund: 0n,
    total: IDENTITY_UPDATE_FEE_ESTIMATE,
  });

  return (
    <div className="bound-key">
      <div className="key-backup">
        <p>
          <strong>Back up this private key now.</strong> It exists only in this tab. Without it,{' '}
          {spec.purpose === 'DECRYPTION'
            ? 'you cannot read the join requests sent to you'
            : 'you cannot read your own join request or send a resignation later'}
          , and nobody can recover it.
        </p>
        <p className="mono key-wif" aria-label={revealed ? 'Private key' : 'Private key, hidden'}>
          {revealed ? generated.wif : '•'.repeat(24)}
        </p>
        <div className="modal-actions">
          <button className="vote-button ghost" onClick={() => setRevealed((r) => !r)} aria-pressed={revealed}>
            {revealed ? 'Hide' : 'Reveal'}
          </button>
          <button className="vote-button ghost" onClick={() => void navigator.clipboard?.writeText(generated.wif)}>
            Copy
          </button>
          <button className="vote-button ghost" onClick={() => downloadBackup(generated, spec, session.identityId)}>
            Download backup
          </button>
        </div>
        <label className="ack">
          <input
            type="checkbox"
            checked={backedUp}
            onChange={(e) => {
              setBackedUp(e.target.checked);
              if (!e.target.checked) setMasterWif('');
            }}
          />{' '}
          I saved this
          private key somewhere safe.
        </label>
      </div>
      {backedUp && (
        <PaidWrite
          handle={handle}
          identityId={session.identityId}
          title={`Add the ${what} to your identity`}
          priceKey={generated.publicKeyHex}
          summary={[
            ['Identity', session.names[0] ?? <span className="mono">{shortId(session.identityId)}</span>],
            ['New key', `A ${what}, usable only with the moderation charters contract`],
            ['Public key', <span className="mono">{shortId(generated.publicKeyHex)}</span>],
          ]}
          estimate={estimate}
          blockers={masterWif.trim() ? [] : ['Paste your master key to sign the update.']}
          confirmLabel="Sign with master key and add"
          doneText="The key is on your identity and loaded for this session."
          run={async () => {
            const wif = masterWif;
            setMasterWif('');
            return addBoundKey(handle, { identityId: session.identityId, masterWif: wif, spec, newKey: generated });
          }}
        >
          <label className="field">
            <span className="field-label">Your identity&apos;s master key (WIF)</span>
            <span className="field-hint">Used to sign this one update, then dropped. It is never stored or sent anywhere.</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={masterWif}
              onChange={(e) => setMasterWif(e.target.value)}
            />
          </label>
        </PaidWrite>
      )}
    </div>
  );
}
