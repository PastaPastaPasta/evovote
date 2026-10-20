import { describe, expect, it, vi } from 'vitest';
import { CHARTERS_CONTRACT_ID } from '../charters/documents';
import { describeWriteError, REFUSALS } from '../voting/refusals';
import {
  boundsFromJson,
  canSignDocumentsFor,
  isBoundKey,
  isMasterKey,
  keyInfoFrom,
  keyMatching,
  keyRoleText,
  nextKeyId,
  signInKeyRefusal,
  type KeyInfo,
} from './keys';
import { settleWrite } from './outcome';

const OTHER_CONTRACT = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

const key = (over: Partial<KeyInfo>): KeyInfo => ({
  keyId: 1,
  purpose: 'AUTHENTICATION',
  securityLevel: 'HIGH',
  keyType: 'ECDSA_SECP256K1',
  readOnly: false,
  disabled: false,
  dataHex: '02'.padEnd(66, 'a'),
  hash160: 'b'.repeat(40),
  ...over,
});

describe('identity keys', () => {
  it('should read the SDK key getters into a KeyInfo', () => {
    const info = keyInfoFrom({
      keyId: 5,
      purpose: 'DECRYPTION',
      securityLevel: 'MEDIUM',
      keyType: 'ECDSA_SECP256K1',
      isReadOnly: false,
      disabledAt: undefined,
      data: '02ABCD',
      contractBounds: {
        toJSON: () => ({ $type: 'documentType', id: CHARTERS_CONTRACT_ID, documentTypeName: 'submittedCharter' }),
      },
      getPublicKeyHash: () => 'ABCDEF',
    });
    expect(info).toEqual({
      keyId: 5,
      purpose: 'DECRYPTION',
      securityLevel: 'MEDIUM',
      keyType: 'ECDSA_SECP256K1',
      readOnly: false,
      disabled: false,
      bounds: { kind: 'documentType', contractId: CHARTERS_CONTRACT_ID, documentTypeName: 'submittedCharter' },
      dataHex: '02abcd',
      hash160: 'abcdef',
    });
    expect(isBoundKey(info, 'DECRYPTION', CHARTERS_CONTRACT_ID, 'submittedCharter')).toBe(true);
    expect(isBoundKey(info, 'ENCRYPTION', CHARTERS_CONTRACT_ID, 'submittedCharter')).toBe(false);
    expect(isBoundKey(info, 'DECRYPTION', CHARTERS_CONTRACT_ID, 'joinRequest')).toBe(false);
    expect(isBoundKey({ ...info, disabled: true }, 'DECRYPTION', CHARTERS_CONTRACT_ID, 'submittedCharter')).toBe(false);
    expect(keyRoleText(info)).toBe('DECRYPTION · MEDIUM — decrypts messages sent to you');
  });

  it('should not count a whole-contract bound as a document-type bound', () => {
    const wholeContract = key({
      purpose: 'DECRYPTION',
      securityLevel: 'MEDIUM',
      bounds: { kind: 'singleContract', contractId: CHARTERS_CONTRACT_ID },
    });
    expect(isBoundKey(wholeContract, 'DECRYPTION', CHARTERS_CONTRACT_ID, 'submittedCharter')).toBe(false);
  });

  it('should let only enabled HIGH/CRITICAL authentication keys sign documents', () => {
    expect(canSignDocumentsFor(key({}), CHARTERS_CONTRACT_ID)).toBe(true);
    expect(canSignDocumentsFor(key({ securityLevel: 'CRITICAL' }), CHARTERS_CONTRACT_ID)).toBe(true);
    expect(canSignDocumentsFor(key({ securityLevel: 'MASTER' }), CHARTERS_CONTRACT_ID)).toBe(false);
    expect(canSignDocumentsFor(key({ securityLevel: 'MEDIUM' }), CHARTERS_CONTRACT_ID)).toBe(false);
    expect(canSignDocumentsFor(key({ purpose: 'TRANSFER', securityLevel: 'CRITICAL' }), CHARTERS_CONTRACT_ID)).toBe(false);
    expect(canSignDocumentsFor(key({ disabled: true }), CHARTERS_CONTRACT_ID)).toBe(false);
    expect(canSignDocumentsFor(key({ bounds: { kind: 'singleContract', contractId: CHARTERS_CONTRACT_ID } }), CHARTERS_CONTRACT_ID)).toBe(true);
    expect(canSignDocumentsFor(key({ bounds: { kind: 'singleContract', contractId: OTHER_CONTRACT } }), CHARTERS_CONTRACT_ID)).toBe(false);
    expect(isMasterKey(key({ securityLevel: 'MASTER' }))).toBe(true);
    expect(isMasterKey(key({ securityLevel: 'MASTER', disabled: true }))).toBe(false);
  });

  it('should match a private key to its identity key by public key or hash', () => {
    const secp = key({ keyId: 1, dataHex: '02' + 'a'.repeat(64), hash160: '1'.repeat(40) });
    const hash = key({ keyId: 2, keyType: 'ECDSA_HASH160', dataHex: '2'.repeat(40), hash160: '2'.repeat(40) });
    expect(keyMatching([secp, hash], '02' + 'A'.repeat(64), 'x')).toBe(secp);
    expect(keyMatching([secp, hash], '03' + 'f'.repeat(64), '2'.repeat(40))).toBe(hash);
    expect(keyMatching([secp, hash], '03' + 'f'.repeat(64), '9'.repeat(40))).toBeUndefined();
  });

  it('should give a new key the id after the highest, disabled keys included', () => {
    expect(nextKeyId([{ keyId: 0 }, { keyId: 1 }, { keyId: 4 }])).toBe(5);
    expect(nextKeyId([])).toBe(0);
  });

});

describe('key bounds', () => {
  const bound = (b: KeyInfo['bounds']) => key({ bounds: b });

  it('should keep the kind of bound from $type', () => {
    expect(boundsFromJson({ $type: 'singleContract', id: CHARTERS_CONTRACT_ID })).toEqual({
      kind: 'singleContract',
      contractId: CHARTERS_CONTRACT_ID,
    });
    expect(boundsFromJson({ $type: 'documentType', id: CHARTERS_CONTRACT_ID, documentTypeName: 'reason' })).toEqual({
      kind: 'documentType',
      contractId: CHARTERS_CONTRACT_ID,
      documentTypeName: 'reason',
    });
    // A group id is not a contract id.
    expect(boundsFromJson({ $type: 'contractGroup', id: OTHER_CONTRACT })).toEqual({ kind: 'contractGroup', groupId: OTHER_CONTRACT });
    expect(boundsFromJson({ $type: 'somethingNew', id: OTHER_CONTRACT })).toEqual({ kind: 'unknown' });
    expect(boundsFromJson({ $type: 'documentType', id: OTHER_CONTRACT })).toEqual({ kind: 'unknown' });
  });

  it('should treat unreadable bounds as bound to something unknown, never unbound', () => {
    const info = keyInfoFrom({
      keyId: 1,
      purpose: 'AUTHENTICATION',
      securityLevel: 'HIGH',
      keyType: 'ECDSA_SECP256K1',
      isReadOnly: false,
      data: '02',
      contractBounds: {
        toJSON: () => {
          throw new Error('freed');
        },
      },
      getPublicKeyHash: () => 'aa',
    });
    expect(info.bounds).toEqual({ kind: 'unknown' });
    expect(canSignDocumentsFor(info, CHARTERS_CONTRACT_ID, 'reason')).toBe(false);
  });

  it('should let a document-type bound key sign only its own type', () => {
    const reasonOnly = bound({ kind: 'documentType', contractId: CHARTERS_CONTRACT_ID, documentTypeName: 'reason' });
    expect(canSignDocumentsFor(reasonOnly, CHARTERS_CONTRACT_ID, 'reason')).toBe(true);
    expect(canSignDocumentsFor(reasonOnly, CHARTERS_CONTRACT_ID, 'submittedCharter')).toBe(false);
    expect(canSignDocumentsFor(reasonOnly, CHARTERS_CONTRACT_ID)).toBe(false);
    expect(canSignDocumentsFor(reasonOnly, OTHER_CONTRACT, 'reason')).toBe(false);
  });

  it('should never let a group or unknown bound sign here', () => {
    expect(canSignDocumentsFor(bound({ kind: 'contractGroup', groupId: CHARTERS_CONTRACT_ID }), CHARTERS_CONTRACT_ID, 'reason')).toBe(false);
    expect(canSignDocumentsFor(bound({ kind: 'unknown' }), CHARTERS_CONTRACT_ID, 'reason')).toBe(false);
  });

  it('should read the V1 limits', () => {
    const info = keyInfoFrom({
      keyId: 9,
      purpose: 'AUTHENTICATION',
      securityLevel: 'HIGH',
      keyType: 'ECDSA_SECP256K1',
      isReadOnly: false,
      data: '02',
      totalBudget: 10n,
      expiresAt: 123n,
      getPublicKeyHash: () => 'aa',
    });
    expect(info).toMatchObject({ totalBudget: 10n, expiresAt: 123 });
  });
});

describe('signInKeyRefusal', () => {
  const contracts = [CHARTERS_CONTRACT_ID];
  const high = key({ keyId: 1 });
  const critical = key({ keyId: 2, securityLevel: 'CRITICAL' });
  const master = key({ keyId: 0, securityLevel: 'MASTER' });
  const enc = key({ keyId: 3, purpose: 'ENCRYPTION', securityLevel: 'MEDIUM' });
  const transfer = key({ keyId: 4, purpose: 'TRANSFER', securityLevel: 'CRITICAL' });
  const medium = key({ keyId: 5, securityLevel: 'MEDIUM' });
  const elsewhere = key({ keyId: 6, bounds: { kind: 'singleContract', contractId: OTHER_CONTRACT } });
  const keys = [master, high, critical, enc, transfer, medium, elsewhere];

  it('should accept a HIGH or CRITICAL authentication key', () => {
    expect(signInKeyRefusal(high, keys, contracts)).toBeUndefined();
    expect(signInKeyRefusal(critical, keys, contracts)).toBeUndefined();
    expect(signInKeyRefusal(key({ keyId: 8, bounds: { kind: 'singleContract', contractId: CHARTERS_CONTRACT_ID } }), keys, contracts)).toBeUndefined();
  });

  it('should refuse a key that cannot sign, and name the keys that can', () => {
    expect(signInKeyRefusal(enc, keys, contracts)).toBe(
      'Key #3 is an ENCRYPTION key (it encrypts messages to others); it cannot sign comments or filings. Use one of its HIGH or CRITICAL authentication keys instead: key #1 (HIGH), key #2 (CRITICAL).',
    );
    expect(signInKeyRefusal(transfer, keys, contracts)).toMatch(/^Key #4 is a TRANSFER key \(it withdraws and transfers credits\)/);
    expect(signInKeyRefusal(medium, keys, contracts)).toMatch(/^Key #5 is a MEDIUM authentication key; Platform needs HIGH or CRITICAL/);
    expect(signInKeyRefusal(master, keys, contracts)).toMatch(/^That is the identity's MASTER key\. Never paste it to sign in\. Use one of/);
    expect(signInKeyRefusal(elsewhere, keys, contracts)).toMatch(/^Key #6 is bound to contract GWRSAV…, so it can only sign there\./);
    expect(signInKeyRefusal(key({ keyId: 7, disabled: true }), keys, contracts)).toMatch(/^Key #7 of this identity is disabled\./);
  });

  it('should say so when the identity has no key that can sign', () => {
    expect(signInKeyRefusal(enc, [master, enc], contracts)).toMatch(/has no HIGH or CRITICAL authentication key/);
    expect(signInKeyRefusal(enc, [enc, high], contracts)).toMatch(/Use its HIGH or CRITICAL authentication key instead: key #1 \(HIGH\)\.$/);
  });
});

describe('settleWrite', () => {
  const wasmError = (message: string, code = -1) => ({ message, code });

  it('should confirm only once the write is read back', async () => {
    const readBack = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('doc1');
    const outcome = await settleWrite(async () => 'doc1', readBack, { delayMs: 0 });
    expect(outcome).toEqual({ status: 'confirmed', value: 'doc1' });
    expect(readBack).toHaveBeenCalledTimes(2);
    expect(readBack).toHaveBeenCalledWith('doc1');
  });

  it('should report a consensus refusal without reading back', async () => {
    const readBack = vi.fn();
    const outcome = await settleWrite(async () => {
      throw wasmError('duplicate unique index', 40105);
    }, readBack);
    expect(outcome).toEqual({
      status: 'refused',
      error: { code: 40105, message: REFUSALS[40105], detail: 'duplicate unique index' },
    });
    expect(readBack).not.toHaveBeenCalled();
  });

  it('should read back after a write with no verdict, and say unknown when it is not found', async () => {
    const found = await settleWrite(
      async () => {
        throw wasmError('timed out waiting for the result');
      },
      async (written) => (written === undefined ? 'landed' : undefined),
      { delayMs: 0 },
    );
    expect(found).toEqual({ status: 'confirmed', value: 'landed' });

    const lost = await settleWrite(
      async () => {
        throw wasmError('connection reset');
      },
      async () => undefined,
      { attempts: 2, delayMs: 0 },
    );
    expect(lost).toMatchObject({ status: 'unknown', error: { message: 'connection reset' } });
  });

  it('should say pending, not unknown, when the SDK accepted the write but the read-back lags', async () => {
    expect(await settleWrite(async () => 'id', async () => undefined, { attempts: 2, delayMs: 0 })).toEqual({
      status: 'pending',
    });
  });

  it('should treat a failing read-back as no verdict yet', async () => {
    const readBack = vi.fn().mockRejectedValueOnce(new Error('node down')).mockResolvedValueOnce(true);
    expect(await settleWrite(async () => undefined, readBack, { delayMs: 0 })).toEqual({ status: 'confirmed', value: true });
  });
});

describe('write refusals', () => {
  it('should word the moderator-election refusals', () => {
    for (const code of [40105, 40111, 40112, 40120, 40135, 40136, 41203, 10422, 40210]) {
      expect(REFUSALS[code]).toBeTruthy();
    }
    expect(describeWriteError({ message: 'x', code: 40135 }).message).toMatch(/elected moderation/);
    expect(describeWriteError({ message: 'x', code: 49998 }).message).toBe('Platform refused the write (code 49998).');
  });
});
