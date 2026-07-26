const KEY_BYTES = 32;
const IV_BYTES = 12;
const FILE_VERSION = 1;
const PASSWORD_CHECK_TEXT = "online-toolkit/private-room/v1";
const GENERATED_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PASSWORD_KDF_ITERATIONS = 600_000;
export const PASSWORD_ROOM_SCHEME = "password-v1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function webCrypto() {
  const instance = globalThis.crypto;
  if (!instance?.subtle || !instance?.getRandomValues) {
    throw new Error("当前浏览器不支持端到端加密");
  }
  return instance;
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("分享密钥格式不正确");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function generateShareKey() {
  const bytes = webCrypto().getRandomValues(new Uint8Array(KEY_BYTES));
  return importShareKey(bytesToBase64Url(bytes));
}

export async function importShareKey(encodedKey) {
  const bytes = base64UrlToBytes(encodedKey);
  if (bytes.byteLength !== KEY_BYTES) throw new Error("分享密钥长度不正确");
  return webCrypto().subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportShareKey(key) {
  const bytes = new Uint8Array(await webCrypto().subtle.exportKey("raw", key));
  return bytesToBase64Url(bytes);
}

export function generateRoomSalt(byteLength = 16) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 32) {
    throw new RangeError("房间盐值长度不正确");
  }
  return bytesToBase64Url(webCrypto().getRandomValues(new Uint8Array(byteLength)));
}

export async function derivePasswordRoomSecrets(
  password,
  salt,
  iterations = PASSWORD_KDF_ITERATIONS
) {
  const normalizedPassword = String(password ?? "").normalize("NFKC");
  if (!normalizedPassword) throw new Error("请输入房间密码");
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 2_000_000) {
    throw new Error("房间密钥参数不受支持");
  }
  const saltBytes = base64UrlToBytes(salt);
  if (saltBytes.byteLength < 16 || saltBytes.byteLength > 32) {
    throw new Error("房间盐值格式不正确");
  }
  const passwordKey = await webCrypto().subtle.importKey(
    "raw",
    textEncoder.encode(normalizedPassword),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = new Uint8Array(await webCrypto().subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: saltBytes,
    iterations
  }, passwordKey, KEY_BYTES * 16));
  const key = await webCrypto().subtle.importKey(
    "raw",
    derived.slice(0, KEY_BYTES),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  return {
    key,
    writeToken: bytesToBase64Url(derived.slice(KEY_BYTES, KEY_BYTES * 2))
  };
}

export async function hashRoomToken(token) {
  const digest = await webCrypto().subtle.digest("SHA-256", textEncoder.encode(String(token)));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function createPasswordRoomSecrets(
  password,
  iterations = PASSWORD_KDF_ITERATIONS
) {
  const salt = generateRoomSalt();
  const secrets = await derivePasswordRoomSecrets(password, salt, iterations);
  return {
    ...secrets,
    crypto: {
      scheme: PASSWORD_ROOM_SCHEME,
      kdf: "PBKDF2-HMAC-SHA256",
      salt,
      iterations,
      check: await encryptText(PASSWORD_CHECK_TEXT, secrets.key)
    }
  };
}

export async function unlockPasswordRoom(password, metadata) {
  if (
    !metadata ||
    metadata.scheme !== PASSWORD_ROOM_SCHEME ||
    metadata.kdf !== "PBKDF2-HMAC-SHA256" ||
    !metadata.check
  ) {
    throw new Error("房间加密参数不受支持");
  }
  const secrets = await derivePasswordRoomSecrets(
    password,
    metadata.salt,
    metadata.iterations
  );
  try {
    if ((await decryptText(metadata.check, secrets.key)) !== PASSWORD_CHECK_TEXT) throw new Error();
  } catch {
    throw new Error("房间密码不正确");
  }
  return secrets;
}

export async function encryptBytes(value, key) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const iv = webCrypto().getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await webCrypto().subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return {
    v: FILE_VERSION,
    alg: "A256GCM",
    iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(new Uint8Array(encrypted))
  };
}

export async function decryptBytes(envelope, key) {
  if (!envelope || envelope.v !== FILE_VERSION || envelope.alg !== "A256GCM") {
    throw new Error("加密内容版本不受支持");
  }
  try {
    const decrypted = await webCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv) },
      key,
      base64UrlToBytes(envelope.data)
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new Error("无法解密内容，请检查分享链接是否完整");
  }
}

export async function encryptText(value, key) {
  return encryptBytes(textEncoder.encode(String(value)), key);
}

export async function decryptText(envelope, key) {
  return textDecoder.decode(await decryptBytes(envelope, key));
}

export async function encryptJson(value, key) {
  return encryptText(JSON.stringify(value), key);
}

export async function decryptJson(envelope, key) {
  try {
    return JSON.parse(await decryptText(envelope, key));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("加密内容不是有效数据");
    throw error;
  }
}

/**
 * File wire format: 1 version byte + 12-byte IV + AES-GCM ciphertext/tag.
 * Keeping the IV in the body avoids base64 overhead for large files.
 */
export async function encryptFile(file, key) {
  const source = new Uint8Array(await file.arrayBuffer());
  const iv = webCrypto().getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = new Uint8Array(
    await webCrypto().subtle.encrypt({ name: "AES-GCM", iv }, key, source)
  );
  const output = new Uint8Array(1 + IV_BYTES + encrypted.byteLength);
  output[0] = FILE_VERSION;
  output.set(iv, 1);
  output.set(encrypted, 1 + IV_BYTES);
  return new Blob([output], { type: "application/octet-stream" });
}

export async function decryptFile(blob, key, type = "application/octet-stream") {
  const packed = new Uint8Array(await blob.arrayBuffer());
  if (packed.byteLength <= 1 + IV_BYTES || packed[0] !== FILE_VERSION) {
    throw new Error("加密文件格式不受支持");
  }
  try {
    const decrypted = await webCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: packed.subarray(1, 1 + IV_BYTES) },
      key,
      packed.subarray(1 + IV_BYTES)
    );
    return new Blob([decrypted], { type });
  } catch {
    throw new Error("无法解密文件，请检查分享链接是否完整");
  }
}

export function keyFromHash(hash = globalThis.location?.hash || "") {
  const value = String(hash);
  if (value && !value.startsWith("#")) return "";
  const raw = value.replace(/^#/, "");
  if (!raw) return "";
  const params = new URLSearchParams(raw);
  return params.get("key") || (/^[A-Za-z0-9_-]+$/.test(raw) ? raw : "");
}

export function hashForKey(encodedKey) {
  return `#key=${encodeURIComponent(encodedKey)}`;
}

export function randomRoomId(size = 10) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = webCrypto().getRandomValues(new Uint8Array(size));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function generateRoomPassword() {
  const bytes = webCrypto().getRandomValues(new Uint8Array(20));
  const compact = Array.from(
    bytes,
    (byte) => GENERATED_PASSWORD_ALPHABET[byte & 31]
  ).join("");
  return compact.match(/.{4}/g).join("-");
}
