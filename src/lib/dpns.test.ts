import { describe, expect, it } from 'vitest';
import { decodeIndexValue } from './dpns';

const text = (label: string): Uint8Array => {
  const utf8 = new TextEncoder().encode(label);
  return Uint8Array.from([0x12, utf8.length, ...utf8]);
};

describe('decodeIndexValue', () => {
  it('should pass plain strings through', () => {
    expect(decodeIndexValue('dash')).toBe('dash');
  });

  it('should decode 0x12-tagged serialized text values', () => {
    expect(decodeIndexValue(text('dash'))).toBe('dash');
    expect(decodeIndexValue(text('ther0adn0ttaken'))).toBe('ther0adn0ttaken');
    // Plain number arrays occur when WASM values cross serialization layers.
    expect(decodeIndexValue(Array.from(text('z0e')))).toBe('z0e');
  });

  it('should reject wrong tags, length mismatches, and invalid UTF-8', () => {
    expect(decodeIndexValue(Uint8Array.from([0x13, 1, 97]))).toBeUndefined();
    expect(decodeIndexValue(Uint8Array.from([0x12, 5, 97]))).toBeUndefined();
    expect(decodeIndexValue(Uint8Array.from([0x12, 2, 0xff, 0xfe]))).toBeUndefined();
    expect(decodeIndexValue(Uint8Array.from([]))).toBeUndefined();
    expect(decodeIndexValue(42)).toBeUndefined();
    expect(decodeIndexValue(null)).toBeUndefined();
  });
});
