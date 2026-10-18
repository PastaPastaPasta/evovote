import { bytesToHex, hexToBytes } from '../model/bytes';
import type { SdkHandle } from '../sdk/connection';
import { freeQuietly } from '../sdk/free';
import type { Network } from '../sdk/network';
import { wifNetwork } from '../voting/keys';
import { isBoundKey, isMasterKey, keyInfosOf, nextKeyId, type KeyInfo } from './keys';
import { settleWrite, type WriteOutcome } from './outcome';

/**
 * Adding a contract-bound encryption or decryption key to an identity: an
 * identity update signed with the MASTER key, which is asked for just in
 * time, used for this one transition and dropped. The new key also signs
 * its own registration (proof of possession), so the signer holds both.
 *
 * The keypair is generated in the browser. Its private half exists nowhere
 * else: the user must back it up before it is registered, or messages
 * encrypted to it are lost.
 */
export interface BoundKeySpec {
  purpose: 'ENCRYPTION' | 'DECRYPTION';
  contractId: string;
  documentTypeName: string;
}

/**
 * Rough fee of an identity update adding one key, in credits (0.001 DASH),
 * from testnet runs of the Yappr election tooling (~11 updates ≈ 0.01 DASH).
 * The SDK has no estimator for identity updates; the balance check uses this.
 */
export const IDENTITY_UPDATE_FEE_ESTIMATE = 100_000_000n;

export interface GeneratedKey {
  privateKeyHex: string;
  /** For the user's backup. */
  wif: string;
  publicKeyHex: string;
  hash160: string;
}

type SdkModule = SdkHandle['mod'];

/** A fresh secp256k1 keypair for `network`, from the browser's CSPRNG. */
export function generateKey(mod: SdkModule, network: Network): GeneratedKey {
  const privateKey = mod.PrivateKey.fromBytes(crypto.getRandomValues(new Uint8Array(32)), network);
  try {
    return describePrivateKey(privateKey);
  } finally {
    freeQuietly(privateKey);
  }
}

function describePrivateKey(privateKey: SdkModule['PrivateKey']['prototype']): GeneratedKey {
  const pub = privateKey.getPublicKey();
  try {
    return {
      privateKeyHex: privateKey.toHex().toLowerCase(),
      wif: privateKey.toWIF(),
      publicKeyHex: bytesToHex(pub.toBytes()),
      hash160: privateKey.getPublicKeyHash().toLowerCase(),
    };
  } finally {
    freeQuietly(pub);
  }
}

/**
 * Check a pasted WIF is the private half of `onChain` (an existing bound
 * key), so a leader can bring back the decryption key generated earlier.
 */
export function importPrivateKeyFor(
  mod: SdkModule,
  network: Network,
  wif: string,
  onChain: KeyInfo,
): { ok: true; key: GeneratedKey } | { ok: false; error: string } {
  const trimmed = wif.trim();
  const keyNetwork = wifNetwork(trimmed);
  if (!keyNetwork) return { ok: false, error: 'That is not a Dash private key in WIF format.' };
  if (keyNetwork !== network) return { ok: false, error: `This is a ${keyNetwork} key, but you are on ${network}.` };
  const privateKey = mod.PrivateKey.fromWIF(trimmed);
  try {
    const key = describePrivateKey(privateKey);
    if (key.publicKeyHex !== onChain.dataHex && key.hash160 !== onChain.hash160) {
      return { ok: false, error: `This is not the private key of key #${onChain.keyId}.` };
    }
    return { ok: true, key };
  } finally {
    freeQuietly(privateKey);
  }
}

/** The key to register: MEDIUM, ECDSA_SECP256K1, bound to one document type. */
export function boundKeyInCreation(
  mod: SdkModule,
  spec: BoundKeySpec,
  keyId: number,
  publicKeyHex: string,
): InstanceType<SdkModule['IdentityPublicKeyInCreation']> {
  return new mod.IdentityPublicKeyInCreation({
    keyId,
    purpose: spec.purpose === 'ENCRYPTION' ? 'encryption' : 'decryption',
    securityLevel: 'medium',
    keyType: 'ecdsa_secp256k1',
    isReadOnly: false,
    data: hexToBytes(publicKeyHex),
    contractBounds: mod.ContractBounds.SingleContractDocumentType(spec.contractId, spec.documentTypeName),
  });
}

/** The identity's existing key meeting `spec`, if any. */
export function existingBoundKey(keys: readonly KeyInfo[], spec: BoundKeySpec): KeyInfo | undefined {
  return keys.find((k) => isBoundKey(k, spec.purpose, spec.contractId, spec.documentTypeName));
}

/**
 * Register `newKey` on the identity, bound per `spec`, signed with
 * `masterWif`. Confirmed by re-reading the identity and finding the key.
 * Throws (before anything is signed) when the master key does not belong
 * to the identity.
 */
export async function addBoundKey(
  handle: SdkHandle,
  args: { identityId: string; masterWif: string; spec: BoundKeySpec; newKey: GeneratedKey },
): Promise<WriteOutcome<KeyInfo>> {
  const { sdk, mod } = handle;
  const masterNetwork = wifNetwork(args.masterWif.trim());
  if (masterNetwork !== handle.network) {
    throw new Error(
      masterNetwork ? `This is a ${masterNetwork} key, but you are on ${handle.network}.` : 'That is not a Dash private key in WIF format.',
    );
  }
  const owned: unknown[] = [];
  const own = <T>(obj: T): T => {
    owned.push(obj);
    return obj;
  };
  try {
    const identity = own(await sdk.identities.fetch(args.identityId));
    if (!identity) throw new Error('The identity could not be read.');
    const keys = keyInfosOf(identity);
    const master = own(mod.PrivateKey.fromWIF(args.masterWif.trim()));
    const masterHash = master.getPublicKeyHash().toLowerCase();
    if (!keys.some((k) => isMasterKey(k) && k.hash160 === masterHash)) {
      throw new Error("This is not this identity's master key. Nothing was signed.");
    }
    if (existingBoundKey(keys, args.spec)) {
      throw new Error('The identity already has this key. Import its private key instead.');
    }
    const keyId = nextKeyId(keys);
    const inCreation = own(boundKeyInCreation(mod, args.spec, keyId, args.newKey.publicKeyHex));
    const signer = own(new mod.IdentitySigner());
    signer.addKey(master);
    signer.addKey(own(mod.PrivateKey.fromHex(args.newKey.privateKeyHex, handle.network)));

    return await settleWrite(
      () => sdk.identities.update({ identity, addPublicKeys: [inCreation], signer }),
      async () => {
        const fresh = await sdk.identities.fetch(args.identityId);
        if (!fresh) return undefined;
        try {
          const { purpose, contractId, documentTypeName } = args.spec;
          return keyInfosOf(fresh).find(
            (k) => k.dataHex === args.newKey.publicKeyHex && isBoundKey(k, purpose, contractId, documentTypeName),
          );
        } finally {
          freeQuietly(fresh);
        }
      },
    );
  } finally {
    owned.forEach(freeQuietly);
  }
}
