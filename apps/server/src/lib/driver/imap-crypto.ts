/**
 * Password encryption for the IMAP provider.
 *
 * Uses WebCrypto AES-256-GCM, which is available both in workerd (the save
 * path, step f) and in Node 22 (the sidecar decrypt path) — avoiding the
 * incomplete `node:crypto` cipher shim in workerd.
 *
 * Ciphertext format: `<base64url(iv)>.<base64url(ciphertext+tag)>`.
 * The key is a 32-byte value provided as 64 hex chars via IMAP_ENCRYPTION_KEY.
 */

const IV_BYTES = 12;

const toB64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64Url = (value: string): Uint8Array => {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('IMAP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

const importKey = async (keyHex: string): Promise<import('node:crypto').webcrypto.CryptoKey> =>
  crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);

export async function encryptPassword(plaintext: string, keyHex: string): Promise<string> {
  const key = await importKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return `${toB64Url(iv)}.${toB64Url(new Uint8Array(cipher))}`;
}

export async function decryptPassword(ciphertext: string, keyHex: string): Promise<string> {
  const [ivPart, dataPart] = ciphertext.split('.');
  if (!ivPart || !dataPart) throw new Error('Malformed encrypted password');
  const key = await importKey(keyHex);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64Url(ivPart) },
    key,
    fromB64Url(dataPart),
  );
  return new TextDecoder().decode(plain);
}
