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
import { keyFromPhrase } from '../../identity/phraseKeys';
import { heldPrivateKeyFor, holdPrivateKey, type IdentitySession } from '../../identity/session';
import { errorMessage } from '../../sdk/errors';
import type { SdkHandle } from '../../sdk/connection';
import { shortId } from '../format';
import { PaidWrite } from '../charters/PaidWrite';
import { attempts } from '../attempts';
import { KeySourceToggle, RecoveryPhraseField, type KeySource } from './RecoveryPhraseField';

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
 *   The master key can be pasted, or derived from the recovery phrase (the
 *   phrase is dropped once the key is found; the key is held like a pasted one).
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
  // The phrase first for Dash Wallet users on testnet (they have no WIF); the WIF first elsewhere.
  const [masterSource, setMasterSource] = useState<KeySource>(
    session.via === 'wallet' && session.network === 'testnet' ? 'phrase' : 'wif',
  );
  /** The master key's id, once it was derived from the recovery phrase (its WIF is in `masterWif`). */
  const [phraseMaster, setPhraseMaster] = useState<number | null>(null);
  const [phraseError, setPhraseError] = useState<string | null>(null);
  /** True while a phrase is being checked: the controls around it are locked. */
  const [phraseBusy, setPhraseBusy] = useState(false);
  const [phraseAttempts] = useState(attempts);
  const [revealed, setRevealed] = useState(false);

  /** Drop the master key, and any phrase result still on its way (it must not bring the key back). */
  const clearMaster = () => {
    phraseAttempts.cancel();
    setMasterWif('');
    setPhraseMaster(null);
    setPhraseError(null);
  };

  const masterFromPhrase = async (phrase: string) => {
    clearMaster();
    const current = phraseAttempts.start();
    try {
      const found = await keyFromPhrase(handle, {
        identityId: session.identityId,
        who: session.names[0],
        phrase,
        want: 'master',
      });
      if (!current()) return;
      if (!found.ok) {
        setPhraseError(found.error);
        return;
      }
      setMasterWif(found.wif);
      setPhraseMaster(found.key.keyId);
    } catch (e) {
      if (current()) setPhraseError(errorMessage(e));
    }
  };

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
          Signing in never needs your master key, but adding a key does: you paste it (or enter your recovery
          phrase) once to sign this one update, and it is dropped right after.
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
            disabled={phraseBusy}
            onChange={(e) => {
              setBackedUp(e.target.checked);
              if (!e.target.checked) clearMaster();
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
          blockers={
            masterWif.trim()
              ? []
              : [masterSource === 'phrase' ? 'Enter your recovery phrase to sign the update.' : 'Paste your master key to sign the update.']
          }
          confirmLabel="Sign with master key and add"
          doneText="The key is on your identity and loaded for this session."
          run={async () => {
            const wif = masterWif;
            clearMaster();
            return addBoundKey(handle, { identityId: session.identityId, masterWif: wif, spec, newKey: generated });
          }}
        >
          <div className="field">
            <span className="field-label">Your identity&apos;s master key</span>
            <span className="field-hint">Used to sign this one update, then dropped. It is never stored or sent anywhere.</span>
            <KeySourceToggle
              value={masterSource}
              disabled={phraseBusy}
              onChange={(next) => {
                setMasterSource(next);
                clearMaster();
              }}
            />
            {masterSource === 'phrase' ? (
              phraseMaster !== null ? (
                <p className="page-note ok">
                  Found your master key (key #{phraseMaster}) in the recovery phrase. It signs this one update; the
                  phrase was not kept.{' '}
                  <button className="link-button" onClick={clearMaster}>
                    Clear
                  </button>
                </p>
              ) : (
                <>
                  <RecoveryPhraseField
                    network={session.network}
                    submitLabel="Find master key"
                    onSubmit={masterFromPhrase}
                    onBusyChange={setPhraseBusy}
                  />
                  {phraseError && (
                    <p className="meta error" role="alert">
                      {phraseError}
                    </p>
                  )}
                </>
              )
            ) : (
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Your identity's master key (WIF)"
                placeholder="Master key (WIF)"
                value={masterWif}
                onChange={(e) => setMasterWif(e.target.value)}
              />
            )}
          </div>
        </PaidWrite>
      )}
    </div>
  );
}
