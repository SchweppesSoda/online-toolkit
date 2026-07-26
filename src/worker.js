import { ShareRoom } from "./share-room.js";
import {
  DEFAULT_SHARE_LIMITS,
  BodyTooLargeError,
  envInteger,
  isLegacyRoomId,
  isValidCustomRoomId,
  jsonByteLength,
  normalizeRoomId,
  parseTtlSeconds,
  randomBase64Url,
  readJsonWithLimit,
  roomObjectName,
  sha256Hex
} from "./share-utils.js";

export { ShareRoom };

const API_PREFIX = "/api/share";
const MAX_CREATE_ATTEMPTS = 5;
const LEGACY_HOSTNAME = "id.136136136.xyz";
const DEFAULT_CANONICAL_ORIGIN = "https://tools.136136136.xyz";
const DEFAULT_SHORT_ORIGIN = "https://c.136136136.xyz";
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function error(status, code, message, details) {
  const payload = { ok: false, error: { code, message } };
  if (details !== undefined) payload.error.details = details;
  return jsonResponse(status, payload);
}

function isSharePath(pathname) {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

function configuredOrigin(value, fallback) {
  try {
    const origin = new URL(value ?? fallback);
    if (origin.protocol !== "https:" && origin.protocol !== "http:") throw new Error();
    return origin;
  } catch {
    return new URL(fallback);
  }
}

function legacyRedirect(requestUrl, env) {
  if (requestUrl.hostname.toLowerCase() !== LEGACY_HOSTNAME) return null;

  const canonical = configuredOrigin(
    env.TOOLKIT_CANONICAL_ORIGIN,
    DEFAULT_CANONICAL_ORIGIN
  );
  const incomingPath = requestUrl.pathname;
  if (incomingPath === "/" || incomingPath === "/id-photo") {
    canonical.pathname = "/id-photo/";
  } else if (
    incomingPath.startsWith("/id-photo/") || incomingPath.startsWith("/assets/")
  ) {
    canonical.pathname = incomingPath;
  } else {
    canonical.pathname = `/id-photo${incomingPath}`;
  }
  canonical.search = requestUrl.search;
  return Response.redirect(canonical.toString(), 307);
}

function isClipboardRoomPath(pathname) {
  return /^\/clipboard\/r\/[^/]+\/?$/.test(pathname);
}

function isShortHost(url, env) {
  return url.hostname.toLowerCase() === configuredOrigin(
    env.SHARE_SHORT_ORIGIN,
    DEFAULT_SHORT_ORIGIN
  ).hostname.toLowerCase();
}

function shortRoomFromPath(pathname) {
  const match = pathname.match(/^\/([^/]+)\/?$/);
  if (!match) return "";
  try {
    const roomId = normalizeRoomId(decodeURIComponent(match[1]));
    return roomId && !isLegacyRoomId(roomId) && isValidCustomRoomId(roomId)
      ? roomId
      : "";
  } catch {
    return "";
  }
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const requestOrigin = new URL(request.url).origin;
  if (origin === requestOrigin) return origin;

  const configured = String(env.SHARE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.includes("*")) return "*";
  return configured.includes(origin) ? origin : false;
}

function withApiHeaders(response, request, env) {
  const headers = new Headers(response.headers);
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", "Content-Disposition, Content-Length, ETag");
    headers.append("vary", "Origin");
  }
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function preflight(request, env) {
  const origin = allowedOrigin(request, env);
  if (origin === false) return error(403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed.");

  const headers = new Headers({
    "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, X-File-Name, X-File-Type, X-File-Meta",
    "access-control-max-age": "86400",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return new Response(null, { status: 204, headers });
}

function ttlConfig(env) {
  const min = envInteger(
    env.SHARE_MIN_TTL_SECONDS,
    DEFAULT_SHARE_LIMITS.minTtlSeconds,
    { min: 60, max: 24 * 60 * 60 }
  );
  const max = envInteger(
    env.SHARE_MAX_TTL_SECONDS,
    DEFAULT_SHARE_LIMITS.maxTtlSeconds,
    { min, max: 30 * 24 * 60 * 60 }
  );
  const defaultValue = envInteger(
    env.SHARE_DEFAULT_TTL_SECONDS,
    DEFAULT_SHARE_LIMITS.defaultTtlSeconds,
    { min, max }
  );
  return { min, max, defaultValue };
}

function privateCrypto(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Private rooms require password encryption metadata.");
  }
  if (
    value.scheme !== "password-v1" ||
    value.kdf !== "PBKDF2-HMAC-SHA256" ||
    typeof value.salt !== "string" ||
    !BASE64URL_PATTERN.test(value.salt) ||
    value.salt.length < 22 ||
    value.salt.length > 43 ||
    !Number.isSafeInteger(value.iterations) ||
    value.iterations < 100_000 ||
    value.iterations > 2_000_000 ||
    !value.check ||
    value.check.v !== 1 ||
    value.check.alg !== "A256GCM" ||
    typeof value.check.iv !== "string" ||
    typeof value.check.data !== "string" ||
    !BASE64URL_PATTERN.test(value.check.iv) ||
    !BASE64URL_PATTERN.test(value.check.data) ||
    jsonByteLength(value) > 2048
  ) {
    throw new TypeError("Private room encryption metadata is invalid.");
  }
  return {
    scheme: value.scheme,
    kdf: value.kdf,
    salt: value.salt,
    iterations: value.iterations,
    check: {
      v: 1,
      alg: "A256GCM",
      iv: value.check.iv,
      data: value.check.data
    }
  };
}

async function createRoom(request, env) {
  let body;
  try {
    body = await readJsonWithLimit(request, 4096, { allowEmpty: true });
  } catch (caught) {
    if (caught instanceof BodyTooLargeError) {
      return error(413, "PAYLOAD_TOO_LARGE", caught.message);
    }
    return error(400, "INVALID_REQUEST", caught.message);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }

  let ttlSeconds;
  try {
    ttlSeconds = parseTtlSeconds(body.ttlSeconds, ttlConfig(env));
  } catch (caught) {
    return error(400, "INVALID_TTL", caught.message);
  }

  const legacyCreate = body.mode === undefined;
  const mode = legacyCreate ? "private" : body.mode;
  if (!["private", "convenience"].includes(mode)) {
    return error(400, "INVALID_MODE", "mode must be private or convenience.");
  }
  if (body.collaborative !== undefined && typeof body.collaborative !== "boolean") {
    return error(400, "INVALID_REQUEST", "collaborative must be a boolean.");
  }
  const collaborative = legacyCreate ? false : body.collaborative !== false;

  const requestedRoomId = body.roomId === undefined ? undefined : normalizeRoomId(body.roomId);
  if (body.roomId !== undefined && !requestedRoomId) {
    return error(
      400,
      "INVALID_ROOM_ID",
      "Room names must be 3-16 letters, numbers, Chinese characters, dashes, or underscores."
    );
  }
  if (
    requestedRoomId !== undefined &&
    !isLegacyRoomId(requestedRoomId) &&
    env.SHARE_ALLOW_CUSTOM_ROOM_IDS !== "true"
  ) {
    return error(
      400,
      "CUSTOM_ROOM_IDS_DISABLED",
      "Custom room names are disabled."
    );
  }

  let crypto = null;
  let suppliedWriteTokenHash = null;
  try {
    if (!legacyCreate && mode === "private") {
      crypto = privateCrypto(body.crypto);
      if (collaborative) {
        if (!TOKEN_HASH_PATTERN.test(body.writeTokenHash ?? "")) {
          throw new TypeError("A collaborative private room requires a write token hash.");
        }
        suppliedWriteTokenHash = body.writeTokenHash.toLowerCase();
      }
    } else if (mode === "convenience" && body.crypto != null) {
      throw new TypeError("Convenience rooms do not accept encryption metadata.");
    }
  } catch (caught) {
    return error(400, "INVALID_CRYPTO", caught.message);
  }

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const roomId = requestedRoomId ?? randomBase64Url(18);
    const ownerToken = randomBase64Url(32);
    const ownerTokenHash = await sha256Hex(ownerToken);
    const writeTokenHash = suppliedWriteTokenHash ?? ownerTokenHash;
    const id = env.SHARE_ROOMS.idFromName(roomObjectName(roomId));
    const stub = env.SHARE_ROOMS.get(id);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const response = await stub.fetch("https://share.internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId,
        mode,
        crypto,
        collaborative,
        publicWritable: mode === "convenience" && collaborative,
        writeTokenHash,
        ownerTokenHash,
        expiresAt
      })
    });

    if (response.status === 409 && !requestedRoomId) continue;
    if (response.status === 409) {
      return error(409, "ROOM_EXISTS", "That room name is already in use.");
    }
    if (!response.ok) return response;

    const result = await response.json();
    return jsonResponse(201, {
      ok: true,
      data: {
        ...result.data,
        ownerToken,
        writeToken: ownerToken
      }
    });
  }
  return error(503, "ROOM_ID_UNAVAILABLE", "A unique room could not be allocated.");
}

async function forwardRoomRequest(request, env, parts) {
  let decodedRoomId;
  try {
    decodedRoomId = decodeURIComponent(parts[3]);
  } catch {
    return error(400, "INVALID_ROOM_ID", "Invalid room ID.");
  }
  const roomId = normalizeRoomId(decodedRoomId);
  if (!roomId) return error(400, "INVALID_ROOM_ID", "Invalid room ID.");

  let internalPath;
  if (parts.length === 4) {
    internalPath = "/room";
  } else if (parts.length === 5 && parts[4] === "text") {
    internalPath = "/text";
  } else if (parts.length === 5 && parts[4] === "files") {
    internalPath = "/files";
  } else if (parts.length === 6 && parts[4] === "files") {
    internalPath = `/files/${parts[5]}`;
  } else {
    return error(404, "NOT_FOUND", "Share API route not found.");
  }

  const publicUrl = new URL(request.url);
  const internalUrl = new URL(`https://share.internal${internalPath}`);
  internalUrl.search = publicUrl.search;
  const id = env.SHARE_ROOMS.idFromName(roomObjectName(roomId));
  const stub = env.SHARE_ROOMS.get(id);
  return await stub.fetch(new Request(internalUrl, request));
}

async function handleApi(request, env) {
  if (!env.SHARE_ROOMS) {
    return error(503, "SERVICE_NOT_CONFIGURED", "Share room storage is not configured.");
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length === 3 &&
    parts[0] === "api" &&
    parts[1] === "share" &&
    parts[2] === "rooms"
  ) {
    if (request.method === "POST") return await createRoom(request, env);
    return error(405, "METHOD_NOT_ALLOWED", "Only POST is allowed on this route.");
  }
  if (
    parts.length >= 4 &&
    parts[0] === "api" &&
    parts[1] === "share" &&
    parts[2] === "rooms"
  ) {
    return await forwardRoomRequest(request, env, parts);
  }
  return error(404, "NOT_FOUND", "Share API route not found.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const redirect = legacyRedirect(url, env);
    if (redirect) return redirect;
    if (!isSharePath(url.pathname)) {
      if (
        isClipboardRoomPath(url.pathname) ||
        (isShortHost(url, env) && (url.pathname === "/" || shortRoomFromPath(url.pathname)))
      ) {
        const assetUrl = new URL(request.url);
        assetUrl.pathname = "/clipboard/";
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") return preflight(request, env);
    if (allowedOrigin(request, env) === false) {
      return withApiHeaders(
        error(403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed."),
        request,
        env
      );
    }

    try {
      return withApiHeaders(await handleApi(request, env), request, env);
    } catch (caught) {
      console.error("Share worker request failed", caught);
      return withApiHeaders(
        error(500, "INTERNAL_ERROR", "The share service could not complete the request."),
        request,
        env
      );
    }
  }
};