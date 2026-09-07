import { beforeAll, expect, it, vi } from 'vitest';
import * as mod from '@dashevo/evo-sdk';
import { hexToBytes, p2pkhAddress } from './keys';
import { prepareWalletVote, voterIdentityId, votingAddressHash, walletVoteMatches } from './wallet-vote';
import { DPNS_CONTRACT_ID } from './dpns';
import type { SdkHandle } from './sdk';

beforeAll(async () => { await mod.ensureInitialized(); });
const proTxHash = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('');
const keyHash = '751e76e8199196d454941c45d1b3a323f1433bd6';

it('validates voting address network and checksum', async () => {
  const address = await p2pkhAddress(keyHash, 'testnet');
  expect(votingAddressHash(address, 'testnet')).toEqual(hexToBytes(keyHash));
  expect(() => votingAddressHash(address, 'mainnet')).toThrow('network');
  expect(() => votingAddressHash(address.slice(0, -1) + (address.endsWith('1') ? '2' : '1'), 'testnet')).toThrow();
});

it('builds an unsigned official vote with correct ProTxHash orientation and verifies resulting choice', async () => {
  const voterId = voterIdentityId(proTxHash, hexToBytes(keyHash));
  const identity = new mod.Identity(voterId);
  const votingKey = new mod.IdentityPublicKey({ keyId: 0, purpose: 'voting', securityLevel: 'high',
    keyType: 'ecdsa_hash160', isReadOnly: true, data: hexToBytes(keyHash) });
  identity.addPublicKey(votingKey); votingKey.free();
  const nonce = vi.fn().mockResolvedValueOnce(2n).mockResolvedValue(3n);
  const poll = new mod.VotePoll({ contractId: DPNS_CONTRACT_ID, documentTypeName: 'domain',
    indexName: 'parentNameAndLabel', indexValues: ['dash', 'test'] });
  const choice = mod.ResourceVoteChoice.Lock();
  const vote = new mod.ResourceVote(poll, choice);
  const handle = { mod, sdk: {
    identities: { fetch: async () => identity, nonce },
    voting: { contestedResourceIdentityVotes: async () => new Map([['id', vote]]) },
  } } as unknown as SdkHandle;
  const prepared = await prepareWalletVote(handle, 'testnet', proTxHash, await p2pkhAddress(keyHash, 'testnet'), 'test', { type: 'lock' });
  const state = mod.StateTransition.fromBytes(prepared.bytes);
  const transition = mod.MasternodeVoteTransition.fromStateTransition(state);
  expect(transition.proTxHash.toHex()).toBe(proTxHash);
  expect(transition.voterIdentityId.toString()).toBe(voterId);
  expect(transition.nonce).toBe(3n);
  expect(transition.signature).toHaveLength(0);
  expect(transition.vote.choice.voteType.toLowerCase()).toBe('lock');
  expect(await walletVoteMatches(handle, prepared)).toBe(true);
  transition.free(); state.free(); poll.free(); choice.free();
});

it('does not report an unchanged nonce as a newly verified vote', async () => {
  const query = vi.fn();
  const handle = { mod, sdk: { identities: { nonce: async () => 1n }, voting: { contestedResourceIdentityVotes: query } } } as unknown as SdkHandle;
  expect(await walletVoteMatches(handle, { bytes: new Uint8Array(), voterId: voterIdentityId(proTxHash, hexToBytes(keyHash)),
    nonce: 2n, label: 'test', choice: { type: 'lock' } })).toBe(false);
  expect(query).not.toHaveBeenCalled();
});
