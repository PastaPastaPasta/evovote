import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import vectorsJson from './vectors.json?raw'
import { openAppConnectPayload } from './crypto'
import { parseAppConnectUri } from './request'
import { buildAppConnectVectors, renewVectorRequest, vectorKeys, yapprVectorRequest } from './test-helpers'

/**
 * The published interop vectors. `vectors.json` is what the code produces.
 * (Yappr also checks the copy embedded in its docs/APP_CONNECT_PROFILE.md;
 * that case is dropped here since the doc is not vendored.)
 */
const fixture = JSON.parse(vectorsJson)

describe('App Connect v2 test vectors', () => {
  it('reproduces vectors.json exactly', async () => {
    expect(await buildAppConnectVectors()).toEqual(fixture)
  })

  it('parses the published URIs back to the vector requests', () => {
    const parsed = parseAppConnectUri(fixture.request.uri)
    expect(parsed.request).toEqual(yapprVectorRequest())
    expect(parsed.network).toBe('devnet')
    expect(parsed.callbackUrl).toBe(`https://yap.pr/connect?r=${fixture.request.appEphemeralPubKeyHash}`)
    expect(parseAppConnectUri(fixture.renewRequest.uri).request).toEqual(renewVectorRequest())
  })

  it('decrypts with AES-256-GCM straight from the vector key (WebCrypto)', async () => {
    // EvoVote has no Node types; Yappr's node:crypto check becomes a direct
    // WebCrypto decrypt under the published session key and AAD.
    const bytes = (hex: string) => new Uint8Array(hexToBytes(hex))
    const payload = bytes(fixture.response.encryptedPayload)
    const key = await crypto.subtle.importKey('raw', bytes(fixture.response.sessionKey), 'AES-GCM', false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.slice(0, 12), additionalData: bytes(fixture.response.aad) },
      key,
      payload.slice(12),
    )
    expect(bytesToHex(new Uint8Array(plaintext))).toBe(fixture.response.plaintext)
  })

  it('opens on the app side', async () => {
    const slots = await openAppConnectPayload({
      appEphemeralPrivateKey: vectorKeys.appEphemeralPrivateKey,
      ownerId: vectorKeys.ownerId,
      walletEphemeralPubKey: hexToBytes(fixture.response.walletEphemeralPubKey),
      encryptedPayload: hexToBytes(fixture.response.encryptedPayload),
    })
    expect(slots).toEqual(fixture.inputs.slotPrivateKeys.map(hexToBytes))
  })
})
