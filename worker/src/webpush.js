/* Minimal Web Push (RFC 8291 aes128gcm + VAPID) sender, implemented directly
   against WebCrypto so the Worker has zero npm dependencies. */

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

async function importVapidPrivateKey(publicKeyB64url, privateKeyB64url) {
  const pub = b64urlToBytes(publicKeyB64url); // 65 bytes: 0x04 || X || Y
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(x),
    y: bytesToB64url(y),
    d: privateKeyB64url,
    ext: true
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function buildVapidHeader(endpoint, vapidPublicKey, vapidPrivateKey, subject) {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  };
  const enc = s => bytesToB64url(new TextEncoder().encode(JSON.stringify(s)));
  const unsigned = `${enc(header)}.${enc(payload)}`;
  const key = await importVapidPrivateKey(vapidPublicKey, vapidPrivateKey);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${bytesToB64url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${vapidPublicKey}`;
}

async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
  const prkKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const t1 = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, concatBytes(info, new Uint8Array([1]))));
  return t1.slice(0, length);
}

async function encryptPayload(payloadBytes, uaPublicB64url, authSecretB64url) {
  const uaPublic = b64urlToBytes(uaPublicB64url);
  const authSecret = b64urlToBytes(authSecretB64url);

  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeyPair.privateKey, 256));

  const authInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, sharedSecret, authInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const cek = await hkdf(salt, ikm, cekInfo, 16);
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  const recordSize = 4096;
  const paddingDelimiter = new Uint8Array([2]); // single (final) record
  const plaintext = concatBytes(payloadBytes, paddingDelimiter);

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, plaintext));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = 65;
  header.set(asPublicRaw, 21);

  return concatBytes(header, ciphertext);
}

/**
 * Send a Web Push notification.
 * @param {{endpoint:string, keys:{p256dh:string, auth:string}}} subscription
 * @param {{publicKey:string, privateKey:string, subject:string}} vapid
 * @param {object} payload - JSON-serializable notification payload
 */
export async function sendWebPush(subscription, vapid, payload) {
  const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(payload)), subscription.keys.p256dh, subscription.keys.auth);
  const authHeader = await buildVapidHeader(subscription.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '60'
    },
    body
  });
  return res;
}
