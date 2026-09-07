// Prepare a wallet request without handling any private keys or broadcasting.
import { readFile, writeFile } from 'node:fs/promises';
import * as mod from '@dashevo/evo-sdk';

const [network, ownerId, output = 'discussion-contract.local.json'] = process.argv.slice(2);
if (!['mainnet', 'testnet'].includes(network) || !ownerId) {
  console.error('Usage: npm run contract:prepare -- <mainnet|testnet> <owner-identity-id> [output.json]');
  process.exit(1);
}

function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let result = '';
  while (value) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte) break; result = '1' + result; }
  return result;
}

try {
  const sdk = network === 'mainnet' ? mod.EvoSDK.mainnetTrusted() : mod.EvoSDK.testnetTrusted();
  await sdk.connect();
  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) throw new Error('Contract owner identity not found on the selected network.');
  const keys = identity.publicKeys;
  try {
    const key = keys.find(key => key.purposeNumber === 0 && key.securityLevelNumber === 1 &&
      key.disabledAt == null && !key.contractBounds && [0, 2].includes(key.keyTypeNumber));
    if (!key) throw new Error('Contract creation requires an active CRITICAL authentication key in your wallet.');
    const nonce = (await sdk.identities.nonce(ownerId) ?? 0n) + 1n;
    const schemas = JSON.parse(await readFile(new URL('../contracts/discussion.json', import.meta.url), 'utf8'));
    const contract = new mod.DataContract({ ownerId, identityNonce: nonce, schemas, fullValidation: true, platformVersion: sdk.version() });
    try {
      const create = new mod.DataContractCreateTransition(contract, nonce, sdk.version());
      try {
        const state = create.toStateTransition();
        try {
          state.signaturePublicKeyId = key.keyId;
          const request = {
            network, ownerId, contractId: contract.id.toString(), identityNonce: nonce.toString(),
            signaturePublicKeyId: key.keyId,
            uri: `dash-st:${base58(state.toBytes())}?n=${network === 'mainnet' ? 'm' : 't'}&v=1`,
            contract: contract.toJSON(sdk.version()),
          };
          await writeFile(output, JSON.stringify(request, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          console.log(`Unsigned contract request saved to ${output}`);
          console.log(`Contract ID: ${request.contractId}`);
          console.log('Review the contract and open its uri in your wallet to sign and publish. Regenerate if the identity nonce changes.');
        } finally { state.free(); }
      } finally { create.free(); }
    } finally { contract.free(); }
  } finally { keys.forEach(key => key.free()); identity.free(); }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
