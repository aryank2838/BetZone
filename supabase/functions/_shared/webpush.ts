// Web Push with only WebCrypto, so it runs in Supabase Edge Functions (Deno)
// and in Node (tests) without a library.
//   - Payload encryption: RFC 8291 (aes128gcm content coding, RFC 8188)
//   - Sender identity: VAPID, RFC 8292 (ES256 JWT)

export interface PushSubscriptionKeys {
  endpoint: string;
  /** Browser's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string;
  /** Browser's 16-byte auth secret, base64url. */
  auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (65 bytes). */
  publicKey: string;
  /** P-256 private scalar "d", base64url (32 bytes). */
  privateKey: string;
  /** mailto: or https: contact for the push service. */
  subject: string;
}

const encoder = new TextEncoder();

export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * Encrypts a payload for one subscription (RFC 8291). `salt` and
 * `serverKeys` are only passed by tests; normally they are random.
 */
export async function encryptPayload(
  subscription: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  plaintext: Uint8Array,
  options: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const uaPublic = base64UrlToBytes(subscription.p256dh);
  const authSecret = base64UrlToBytes(subscription.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Invalid p256dh key');
  if (authSecret.length < 16) throw new Error('Invalid auth secret');

  const serverKeys = options.serverKeys
    ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256),
  );

  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  // One record: plaintext followed by the 0x02 "last record" delimiter.
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  if (record.length + 16 > recordSize) throw new Error('Payload too large');
  return concat(header, ciphertext);
}

/** VAPID JWT for the push service that owns `endpoint` (valid 12 hours). */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const publicBytes = base64UrlToBytes(vapid.publicKey);
  if (publicBytes.length !== 65) throw new Error('Invalid VAPID public key');
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: vapid.privateKey,
      x: bytesToBase64Url(publicBytes.slice(1, 33)),
      y: bytesToBase64Url(publicBytes.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToBase64Url(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 60 * 60,
    sub: vapid.subject,
  })));
  const unsigned = `${header}.${claims}`;
  // WebCrypto returns the raw r||s signature that JWS ES256 expects.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoder.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${bytesToBase64Url(signature)}, k=${vapid.publicKey}`;
}

export type PushResult = 'sent' | 'gone' | 'failed';

/**
 * Sends one notification. 'gone' means the subscription no longer exists
 * (404/410) and should be deleted.
 */
export async function sendPush(
  subscription: PushSubscriptionKeys,
  payload: unknown,
  vapid: VapidKeys,
  options: { ttlSeconds?: number; urgency?: 'normal' | 'high'; topic?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ result: PushResult; status: number }> {
  const body = await encryptPayload(subscription, encoder.encode(JSON.stringify(payload)));
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(options.ttlSeconds ?? 24 * 60 * 60),
    Urgency: options.urgency ?? 'normal',
    Authorization: await vapidAuthorization(subscription.endpoint, vapid),
  };
  if (options.topic) headers.Topic = options.topic;
  const response = await (options.fetchImpl ?? fetch)(subscription.endpoint, { method: 'POST', headers, body });
  // Drain the body so the connection can be reused.
  await response.arrayBuffer().catch(() => undefined);
  if (response.status === 404 || response.status === 410) return { result: 'gone', status: response.status };
  return { result: response.ok ? 'sent' : 'failed', status: response.status };
}
