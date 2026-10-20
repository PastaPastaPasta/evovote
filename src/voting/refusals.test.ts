import { describe, expect, it } from 'vitest';
import { errorCode, errorMessage } from '../sdk/errors';
import { describeVoteError, REFUSALS } from './refusals';

/** A stand-in for a wasm-bindgen error object (not an Error instance). */
const wasmError = (message: string, code = -1) => ({ message, code, kind: 'Protocol' });

describe('errorMessage / errorCode', () => {
  it('should read message and consensus code from wasm error objects', () => {
    const e = wasmError('Failed to broadcast: vote already present', 40304);
    expect(errorMessage(e)).toBe('Failed to broadcast: vote already present');
    expect(errorCode(e)).toBe(40304);
  });

  it('should fall back to a code in the message, and ignore -1', () => {
    expect(errorCode(wasmError('too many votes [code 40303]'))).toBe(40303);
    expect(errorCode(wasmError('timeout'))).toBeUndefined();
    expect(errorCode(wasmError('timed out after 10000 ms'))).toBeUndefined();
    expect(errorCode(new Error('Code: 10422 here'))).toBe(10422);
  });

  it('should survive odd inputs', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(undefined)).toBe('undefined');
    const throwing = {
      get message(): string {
        throw new Error('freed');
      },
    };
    expect(() => errorMessage(throwing)).not.toThrow();
  });
});

describe('describeVoteError', () => {
  it('should map the voting refusals the planner and UI care about', () => {
    for (const code of [40303, 40304, 40307, 40111, 40302, 40401]) {
      expect(REFUSALS[code]).toBeTruthy();
      const described = describeVoteError(wasmError(`refused ${code}`, code));
      expect(described).toEqual({ code, message: REFUSALS[code], detail: `refused ${code}` });
    }
    expect(describeVoteError(wasmError('x', 40303)).message).toMatch(/all 5/);
    expect(describeVoteError(wasmError('x', 40307)).message).toMatch(/Lock/);
  });

  it('should name unknown codes and pass other errors through', () => {
    expect(describeVoteError(wasmError('weird', 49999))).toMatchObject({
      message: 'for a reason this site does not recognise (see the technical detail).',
      detail: 'weird (consensus error 49999)',
    });
    expect(describeVoteError(wasmError('network down'))).toEqual({
      code: undefined,
      message: 'network down',
      detail: 'network down',
    });
  });
});
