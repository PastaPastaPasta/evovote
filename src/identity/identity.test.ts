import { describe, expect, it, vi } from 'vitest';
import { CHARTERS_CONTRACT_ID } from '../charters/documents';
import { describeWriteError, REFUSALS } from '../voting/refusals';
import {
  canSignDocumentsFor,
  isBoundKey,
  isMasterKey,
  keyInfoFrom,
  keyMatching,
  keyRoleText,
  nextKeyId,
  type KeyInfo,
} from './keys';
import { settleWrite } from './outcome';
import { documentSigningProblem, type IdentitySession } from './session';

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
      bounds: { contractId: CHARTERS_CONTRACT_ID, documentTypeName: 'submittedCharter' },
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
    const wholeContract = key({ purpose: 'DECRYPTION', securityLevel: 'MEDIUM', bounds: { contractId: CHARTERS_CONTRACT_ID } });
    expect(isBoundKey(wholeContract, 'DECRYPTION', CHARTERS_CONTRACT_ID, 'submittedCharter')).toBe(false);
  });

  it('should let only enabled HIGH/CRITICAL authentication keys sign documents', () => {
    expect(canSignDocumentsFor(key({}), CHARTERS_CONTRACT_ID)).toBe(true);
    expect(canSignDocumentsFor(key({ securityLevel: 'CRITICAL' }), CHARTERS_CONTRACT_ID)).toBe(true);
    expect(canSignDocumentsFor(key({ securityLevel: 'MASTER' }), CHARTERS_CONTRACT_ID)).toBe(false);
    expect(canSignDocumentsFor(key({ securityLevel: 'MEDIUM' }), CHARTERS_CONTRACT_ID)).toBe(false);
    expect(canSignDocumentsFor(key({ purpose: 'TRANSFER', securityLevel: 'CRITICAL' }), CHARTERS_CONTRACT_ID)).toBe(false);
    expect(canSignDocumentsFor(key({ disabled: true }), CHARTERS_CONTRACT_ID)).toBe(false);
    expect(canSignDocumentsFor(key({ bounds: { contractId: CHARTERS_CONTRACT_ID } }), CHARTERS_CONTRACT_ID)).toBe(true);
    expect(canSignDocumentsFor(key({ bounds: { contractId: OTHER_CONTRACT } }), CHARTERS_CONTRACT_ID)).toBe(false);
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

  it('should explain when the session cannot sign documents', () => {
    const session = { loginKey: key({}) } as IdentitySession;
    expect(documentSigningProblem(null, CHARTERS_CONTRACT_ID)).toMatch(/Sign in/);
    expect(documentSigningProblem(session, CHARTERS_CONTRACT_ID)).toBeUndefined();
    expect(
      documentSigningProblem({ ...session, loginKey: key({ securityLevel: 'MEDIUM', purpose: 'ENCRYPTION' }) }, CHARTERS_CONTRACT_ID),
    ).toMatch(/HIGH or CRITICAL/);
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
