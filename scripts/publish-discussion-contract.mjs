// Publish contracts/discussion.json as a new data contract.
//
//   node scripts/publish-discussion-contract.mjs --network testnet --owner <identity-id> \
//        [--key-file <path> | --key-env <VAR>] [--key-id <n>] [--live]
//
// DRY RUN BY DEFAULT: without --live nothing is signed or broadcast. The dry
// run reads the owner identity and nonce, builds the contract with full DPP
// validation, and prints the contract id the live run would create.
//
// The owner key is a CRITICAL authentication key of the owner identity (WIF).
// It is read from a file (first line) or an environment variable, never from
// the command line (shell history) and never written anywhere. The default
// variable is DISCUSSION_OWNER_KEY.
//
// After a live run, set the printed id as the repository variable
// VITE_DISCUSSION_TESTNET_CONTRACT_ID (or ..._MAINNET_...) and rebuild.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as mod from '@dashevo/evo-sdk';

const USAGE =
  'Usage: node scripts/publish-discussion-contract.mjs --network <testnet|mainnet> --owner <identity-id>\n' +
  '         [--key-file <path> | --key-env <VAR>] [--key-id <n>] [--live]\n' +
  'Dry run unless --live. A key is required only with --live.';

function parseArgs(argv) {
  const args = { live: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
      return v;
    };
    switch (flag) {
      case '--network': args.network = value(); break;
      case '--owner': args.owner = value(); break;
      case '--key-file': args.keyFile = value(); break;
      case '--key-env': args.keyEnv = value(); break;
      case '--key-id': args.keyId = Number(value()); break;
      case '--live': args.live = true; break;
      case '--key': case '--wif': case '--private-key':
        throw new Error('Never pass a private key on the command line. Use --key-file or --key-env.');
      default: throw new Error(`Unknown argument ${flag}.`);
    }
  }
  if (!['testnet', 'mainnet'].includes(args.network)) throw new Error('--network must be testnet or mainnet.');
  if (!args.owner) throw new Error('--owner <identity-id> is required.');
  if (args.keyFile && args.keyEnv) throw new Error('Pass --key-file or --key-env, not both.');
  if (args.keyId !== undefined && !Number.isInteger(args.keyId)) throw new Error('--key-id must be an integer.');
  return args;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(text) {
  let value = 0n;
  for (const c of text) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('Not base58.');
    value = value * 58n + BigInt(i);
  }
  const bytes = [];
  while (value > 0n) { bytes.unshift(Number(value % 256n)); value /= 256n; }
  for (const c of text) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

/** 'testnet' | 'mainnet' from a WIF's version byte (0xef / 0xcc), else undefined. */
function wifNetwork(wif) {
  try {
    const bytes = base58Decode(wif);
    if (bytes.length !== 37 && bytes.length !== 38) return undefined;
    return bytes[0] === 0xef ? 'testnet' : bytes[0] === 0xcc ? 'mainnet' : undefined;
  } catch {
    return undefined;
  }
}

async function readKey(args) {
  let raw;
  if (args.keyFile) raw = (await readFile(args.keyFile, 'utf8')).split(/\r?\n/)[0];
  else raw = process.env[args.keyEnv ?? 'DISCUSSION_OWNER_KEY'];
  const wif = raw?.trim();
  if (!wif) return undefined;
  const network = wifNetwork(wif);
  if (!network) throw new Error('The key is not a Dash WIF.');
  if (network !== args.network) throw new Error(`The key is a ${network} key but --network is ${args.network}. Nothing was done.`);
  return wif;
}

const free = (o) => { try { o?.free?.(); } catch { /* already freed */ } };
const credits = (n) => `${Number(n) / 1e11} DASH`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wif = await readKey(args);
  if (args.live && !wif) throw new Error('--live needs the owner key: --key-file <path> or --key-env <VAR> (default DISCUSSION_OWNER_KEY).');

  const schemas = JSON.parse(await readFile(new URL('../contracts/discussion.json', import.meta.url), 'utf8'));
  const schemaHash = createHash('sha256').update(JSON.stringify(schemas)).digest('hex');

  await mod.ensureInitialized?.();
  const sdk = args.network === 'mainnet' ? mod.EvoSDK.mainnetTrusted() : mod.EvoSDK.testnetTrusted();
  await sdk.connect();

  const identity = await sdk.identities.fetch(args.owner);
  if (!identity) throw new Error(`Identity ${args.owner} not found on ${args.network}.`);
  const keys = identity.publicKeys;
  let privateKey, signer, publishKey, contract, published;
  try {
    // Contract creation is signed with a CRITICAL AUTHENTICATION key.
    const usable = keys.filter((k) =>
      String(k.purpose).toUpperCase() === 'AUTHENTICATION' && String(k.securityLevel).toUpperCase() === 'CRITICAL' &&
      (k.disabledAt === undefined || k.disabledAt === null) && !k.contractBounds);
    if (wif) {
      privateKey = mod.PrivateKey.fromWIF(wif);
      const hash = privateKey.getPublicKeyHash().toLowerCase();
      const match = usable.find((k) => k.getPublicKeyHash().toLowerCase() === hash && (args.keyId === undefined || k.keyId === args.keyId));
      if (!match) throw new Error('The key is not an active, unbound CRITICAL authentication key of the owner identity.');
      publishKey = match;
    } else if (usable.length === 0) {
      console.warn('Note: the owner has no active, unbound CRITICAL authentication key; a live run would fail.');
    }

    const nonce = (await sdk.identities.nonce(args.owner) ?? 0n) + 1n;
    contract = new mod.DataContract({ ownerId: args.owner, identityNonce: nonce, schemas, fullValidation: true, platformVersion: sdk.version() });
    const contractId = contract.id.toString();

    console.log(`network:        ${args.network}`);
    console.log(`owner:          ${args.owner}`);
    console.log(`balance:        ${credits(identity.balance)}`);
    console.log(`identity nonce: ${nonce}`);
    console.log(`document types: ${Object.keys(schemas).join(', ')}`);
    console.log(`schema sha256:  ${schemaHash}`);
    console.log(`contract id:    ${contractId}`);

    if (!args.live) {
      console.log('\nDRY RUN: nothing was signed or broadcast. The contract validates. Re-run with --live to publish.');
      console.log('The id depends on the owner nonce: if the owner sends anything first, it changes.');
      return;
    }

    signer = new mod.IdentitySigner();
    signer.addKey(privateKey);
    console.log('\nLIVE: publishing...');
    published = await sdk.contracts.publish({ dataContract: contract, identityKey: publishKey, signer });
    // The id the SDK reports is the contract that exists; it equals the dry-run id
    // unless the owner's nonce moved in between.
    const actualId = published.id.toString();
    if (actualId !== contractId) console.warn(`WARNING: published id ${actualId} differs from the dry-run id ${contractId}.`);
    const onChain = await sdk.contracts.fetch(actualId);
    if (!onChain) throw new Error(`Published as ${actualId}, but the contract could not be read back yet. Check that id before retrying.`);
    const readBack = JSON.stringify(onChain.toJSON(sdk.version()).documentSchemas);
    const expected = JSON.stringify(contract.toJSON(sdk.version()).documentSchemas);
    free(onChain);
    console.log(`published ${actualId}; schemas read back ${readBack === expected ? 'identical to what was sent' : 'DIFFER from what was sent: inspect the contract before using it'}.`);
    console.log(`\nSet the repository variable VITE_DISCUSSION_${args.network.toUpperCase()}_CONTRACT_ID=${actualId}`);
  } finally {
    free(published); free(signer); free(contract); free(privateKey);
    keys.forEach(free); free(identity);
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error?.message ?? String(error));
  console.error(USAGE);
  process.exit(1);
});
