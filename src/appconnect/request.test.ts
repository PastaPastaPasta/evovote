import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../model/bytes';
import { appConnectConfig } from './config';
import { appConnectRequestHash, buildAppConnectUri, KeySecurityLevel, parseAppConnectUri } from './protocol';
import { getYapprPublicKey } from './protocol/legacy';
import { appConnectCallbackUrl, buildEvoVoteRequest } from './request';

const DISCUSSION = '2iaUXM8bZb6paYW1mRWCEUMe8EU1tp4Tbg456PXPN3qt';
const CREATED_AT = 1_792_454_400_000;
const config = { network: 'testnet' as const, appId: DISCUSSION, discussionContractId: DISCUSSION };

function golden() {
  const request = buildEvoVoteRequest({
    config,
    appEphemeralPubKey: getYapprPublicKey(new Uint8Array(32).fill(7)),
    connectionId: new Uint8Array(16).fill(0xab),
    createdAt: CREATED_AT,
  });
  const hash = bytesToHex(appConnectRequestHash(request));
  const cb = appConnectCallbackUrl('https://pastapastapasta.github.io/evovote-testnet/#/p/somecontest', hash);
  return { request, hash, uri: buildAppConnectUri(request, 'testnet', cb) };
}

describe("EvoVote's App Connect request", () => {
  it('encodes to the golden URI', () => {
    const { uri, hash } = golden();
    expect(hash).toBe('a3c6b1ee4a49d9f2af3b3802974744fba924164a');
    expect(uri).toBe(
      'dash-key:2cXLV2P5DaAqWcd4CNTaBocQeSGES48QHomFmfGuvN8dhdQmVkpS29f7DzEWXv7YSXHkzrAbu2RtZYymcTrnZfobDBdTxu5wAXpG1hG4LJ3wvEDMQywt1LBgzrLR3pXtLEyN1y2NLbzKNWVP1aYxpqGNEfRu36hwuy4GpciwMVJ3vRZYbwvCMWjRwivnwQjY9qLtSnZ9TMHQVfhN1m' +
        '?n=t&v=2&cb=https%3A%2F%2Fpastapastapasta.github.io%2Fevovote-testnet%2F%3Fac_r%3Da3c6b1ee4a49d9f2af3b3802974744fba924164a',
    );
  });

  it('decodes as one HIGH binding on the discussion contract, 0.1 DASH for 90 days, labelled EvoVote', () => {
    const parsed = parseAppConnectUri(golden().uri);
    expect(parsed.network).toBe('testnet');
    expect(parsed.callbackUrl).toBe(
      'https://pastapastapasta.github.io/evovote-testnet/?ac_r=a3c6b1ee4a49d9f2af3b3802974744fba924164a',
    );
    expect(parsed.request.label).toBe('EvoVote');
    expect(parsed.request.encBindings).toEqual([]);
    expect(parsed.request.identityHint).toBeUndefined();
    expect(parsed.request.authBindings).toHaveLength(1);
    const [binding] = parsed.request.authBindings;
    expect(binding.kind).toBe('singleContract');
    expect(binding.securityLevel).toBe(KeySecurityLevel.HIGH);
    expect(binding.totalBudget).toBe(10_000_000_000n);
    expect(binding.expiresAt).toBe(CREATED_AT + 90 * 24 * 60 * 60_000);
  });

  it('carries an identity hint on renewal', () => {
    const request = buildEvoVoteRequest({
      config,
      appEphemeralPubKey: getYapprPublicKey(new Uint8Array(32).fill(7)),
      connectionId: new Uint8Array(16),
      createdAt: CREATED_AT,
      identityHint: DISCUSSION,
    });
    expect(parseAppConnectUri(buildAppConnectUri(request, 'testnet')).request.identityHint).toHaveLength(32);
  });
});

describe('appConnectCallbackUrl', () => {
  it('returns to the page root with the request hash, keeping only the network', () => {
    expect(appConnectCallbackUrl('https://example.org/evovote/?network=testnet&x=1#/me', 'ab'.repeat(20))).toBe(
      `https://example.org/evovote/?network=testnet&ac_r=${'ab'.repeat(20)}`,
    );
    expect(appConnectCallbackUrl('https://example.org/evovote/?x=1', 'ab'.repeat(20))).toBe(
      `https://example.org/evovote/?ac_r=${'ab'.repeat(20)}`,
    );
  });

  it('gives no return link on http (local builds poll instead)', () => {
    expect(appConnectCallbackUrl('http://localhost:5304/#/me', 'ab'.repeat(20))).toBeUndefined();
    expect(appConnectCallbackUrl('not a url', 'ab'.repeat(20))).toBeUndefined();
  });
});

describe('appConnectConfig', () => {
  it('uses the discussion contract as the app id unless told otherwise', () => {
    expect(appConnectConfig('testnet', { VITE_DISCUSSION_TESTNET_CONTRACT_ID: DISCUSSION })).toEqual(config);
    expect(
      appConnectConfig('testnet', { VITE_DISCUSSION_TESTNET_CONTRACT_ID: DISCUSSION, VITE_APP_CONNECT_APP_ID_TESTNET: 'off' }),
    ).toBeNull();
    expect(appConnectConfig('testnet', {})).toBeNull();
    expect(appConnectConfig('mainnet', { VITE_DISCUSSION_TESTNET_CONTRACT_ID: DISCUSSION })).toBeNull();
    expect(
      appConnectConfig('testnet', { VITE_DISCUSSION_TESTNET_CONTRACT_ID: DISCUSSION, VITE_APP_CONNECT_APP_ID_TESTNET: 'not-an-id' }),
    ).toBeNull();
  });
});
