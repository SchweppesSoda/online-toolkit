export const DEFAULT_SHARE_LIMITS = Object.freeze({
  defaultTtlSeconds: 24 * 60 * 60,
  minTtlSeconds: 5 * 60,
  maxTtlSeconds: 7 * 24 * 60 * 60,
  maxPayloadBytes: 64 * 1024,
  maxFileMetaBytes: 8 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxRoomBytes: 200 * 1024 * 1024,
  maxFiles: 10
});

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LEGACY_ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{20,48}$/;
const CUSTOM_ROOM_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]*[\p{L}\p{N}]$/u;
const RESERVED_ROOM_IDS = new Set([
  "api",
  "assets",
  "clipboard",
  "favicon",
  "id-photo",
  "robots",
  "src",
  "tools"
]);
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{16,48}$/;

export class BodyTooLargeError extends Error {
  constructor(message = "Request body is too large.") {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

export function jsonByteLength(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Value is not JSON serializable.");
  }
  return utf8ByteLength(serialized);
}

export function parseTtlSeconds(
  value,
  {
    defaultValue = DEFAULT_SHARE_LIMITS.defaultTtlSeconds,
    min = DEFAULT_SHARE_LIMITS.minTtlSeconds,
    max = DEFAULT_SHARE_LIMITS.maxTtlSeconds
  } = {}
) {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`ttlSeconds must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function envInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function randomBase64Url(byteLength, cryptoImpl = globalThis.crypto) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new RangeError("byteLength must be a positive integer.");
  }
  if (!cryptoImpl?.getRandomValues) {
    throw new TypeError("A Web Crypto getRandomValues implementation is required.");
  }

  const bytes = new Uint8Array(byteLength);
  cryptoImpl.getRandomValues(bytes);

  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const value = (first << 16) | (second << 8) | third;

    output += BASE64URL_ALPHABET[(value >>> 18) & 63];
    output += BASE64URL_ALPHABET[(value >>> 12) & 63];
    if (hasSecond) output += BASE64URL_ALPHABET[(value >>> 6) & 63];
    if (hasThird) output += BASE64URL_ALPHABET[value & 63];
  }
  return output;
}

export async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) {
    throw new TypeError("A Web Crypto subtle.digest implementation is required.");
  }
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(first, second) {
  const left = String(first);
  const right = String(second);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function parseBearerToken(headerValue) {
  if (typeof headerValue !== "string") return null;
  const match = /^Bearer[ \t]+([A-Za-z0-9_-]{32,128})$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

export function isLegacyRoomId(value) {
  return typeof value === "string" && LEGACY_ROOM_ID_PATTERN.test(value);
}

export function normalizeCustomRoomId(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().toLowerCase();
}

export function isValidCustomRoomId(value) {
  const normalized = normalizeCustomRoomId(value);
  const length = Array.from(normalized).length;
  return (
    length >= 3 &&
    length <= 16 &&
    utf8ByteLength(normalized) <= 64 &&
    !RESERVED_ROOM_IDS.has(normalized) &&
    CUSTOM_ROOM_ID_PATTERN.test(normalized)
  );
}

export function normalizeRoomId(value) {
  if (isLegacyRoomId(value)) return value;
  const normalized = normalizeCustomRoomId(value);
  return isValidCustomRoomId(normalized) ? normalized : "";
}

export function isValidRoomId(value) {
  return normalizeRoomId(value) !== "";
}

export function roomObjectName(roomId) {
  const normalized = normalizeRoomId(roomId);
  if (!normalized) return "";
  return isLegacyRoomId(normalized) ? normalized : `named:${normalized}`;
}

export function isValidFileId(value) {
  return typeof value === "string" && FILE_ID_PATTERN.test(value);
}

export function sanitizeFileName(value, fallback = "shared-file.bin") {
  const name = String(value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[._]+/, "")
    .trim();

  if (!name) return fallback;
  return Array.from(name).slice(0, 180).join("");
}

export function contentDisposition(fileName) {
  const safeName = sanitizeFileName(fileName);
  const asciiName = safeName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encodedName = encodeURIComponent(safeName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

export async function readTextWithLimit(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new BodyTooLargeError();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body limit exceeded");
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function readJsonWithLimit(request, maxBytes, { allowEmpty = false } = {}) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    throw new TypeError("Content-Type must be application/json.");
  }
  const text = await readTextWithLimit(request, maxBytes);
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new SyntaxError("JSON body is required.");
  }
  return JSON.parse(text);
}
