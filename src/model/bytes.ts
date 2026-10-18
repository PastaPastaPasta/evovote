/** Byte encodings shared by the model and the keyring (no SDK needed). */

const B58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = B58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const index = B58_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Invalid base58 character "${char}"`);
    value = value * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Standard base64 to bytes; undefined when it is not valid base64. */
export function base64ToBytesSafe(b64: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** UTF-8 text to unpadded base64url. */
export function base64UrlEncode(textValue: string): string {
  const bytes = new TextEncoder().encode(textValue);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of base64UrlEncode; throws on anything malformed. */
export function base64UrlDecode(encoded: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error('bad base64url');
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** The length of a string in UTF-8 bytes (what Platform's size limits count). */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Whether a string is a base58 Platform identifier (32 bytes). */
export function isBase58Identifier(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}
