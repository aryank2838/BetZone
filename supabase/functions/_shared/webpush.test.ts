import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url, encryptPayload, sendPush, vapidAuthorization } from './webpush.ts';

// The receiving side of RFC 8291, written with node:crypto (not WebCrypto),
// so the test does not share code paths with the implementation under test.
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = new Uint8Array(16).map((_, i) => i * 7 + 3);
  return {
    ecdh,
    p256dh: bytesToBase64Url(new Uint8Array(ecdh.getPublicKey())),
    auth: bytesToBase64Url(auth),
    authBytes: auth,
  };
}

function decrypt(body: Uint8Array, keys: ReturnType<typeof browserKeys>): string {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLength = body[20];
  const serverPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  expect(recordSize).toBe(4096);
  expect(idLength).toBe(65);

  const shared = keys.ecdh.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), keys.ecdh.getPublicKey(), serverPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, keys.authBytes, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.slice(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.slice(0, ciphertext.length - 16)), decipher.final()]);
  // Strip the 0x02 last-record delimiter (and any zero padding before it).
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(2);
  return padded.slice(0, end).toString('utf8');
}

async function vapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: bytesToBase64Url(raw), privateKey: jwk.d!, subject: 'https://betzone.example' };
}

describe('web push encryption', () => {
  it('produces a body the browser can decrypt (RFC 8291)', async () => {
    const keys = browserKeys();
    const message = JSON.stringify({ title: 'पैसे जुड़ गए', body: '₹1,500 आपके बैलेंस में जुड़ गए हैं।' });
    const body = await encryptPayload(keys, new TextEncoder().encode(message));
    expect(decrypt(body, keys)).toBe(message);
  });

  it('uses a fresh salt and key for every message', async () => {
    const keys = browserKeys();
    const a = await encryptPayload(keys, new TextEncoder().encode('same'));
    const b = await encryptPayload(keys, new TextEncoder().encode('same'));
    expect(bytesToBase64Url(a)).not.toBe(bytesToBase64Url(b));
  });

  it('rejects malformed subscription keys', async () => {
    await expect(encryptPayload({ p256dh: 'abc', auth: 'abc' }, new Uint8Array(1))).rejects.toThrow('Invalid p256dh key');
  });
});

describe('VAPID', () => {
  it('signs a JWT for the push service origin that verifies with the public key', async () => {
    const vapid = await vapidKeys();
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', vapid, 1_700_000_000);
    const match = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(match).not.toBeNull();
    const [, token, k] = match!;
    expect(k).toBe(vapid.publicKey);

    const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');
    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedClaims)));
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 43_200, sub: 'https://betzone.example' });
    expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedHeader)))).toEqual({ typ: 'JWT', alg: 'ES256' });

    const publicBytes = base64UrlToBytes(vapid.publicKey);
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: bytesToBase64Url(publicBytes.slice(1, 33)), y: bytesToBase64Url(publicBytes.slice(33)) },
      format: 'jwk',
    });
    const ok = verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      base64UrlToBytes(encodedSignature),
    );
    expect(ok).toBe(true);
  });
});

describe('sendPush', () => {
  it('posts an encrypted body with the Web Push headers, and reports expired subscriptions', async () => {
    const keys = browserKeys();
    const vapid = await vapidKeys();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const subscription = { endpoint: 'https://push.example/sub/1', p256dh: keys.p256dh, auth: keys.auth };

    const ok = await sendPush(subscription, { title: 'Hi' }, vapid, { fetchImpl, urgency: 'high' });
    expect(ok).toEqual({ result: 'sent', status: 201 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(subscription.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.Urgency).toBe('high');
    expect(headers.TTL).toBe('86400');
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(JSON.parse(decrypt(init.body as Uint8Array, keys))).toEqual({ title: 'Hi' });

    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 410 }));
    expect((await sendPush(subscription, {}, vapid, { fetchImpl })).result).toBe('gone');
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect((await sendPush(subscription, {}, vapid, { fetchImpl })).result).toBe('failed');
  });
});
