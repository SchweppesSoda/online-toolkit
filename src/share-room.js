import {
  BodyTooLargeError,
  DEFAULT_SHARE_LIMITS,
  constantTimeEqual,
  contentDisposition,
  envInteger,
  isValidFileId,
  jsonByteLength,
  parseBearerToken,
  randomBase64Url,
  readJsonWithLimit,
  sanitizeFileName,
  sha256Hex,
  utf8ByteLength
} from "./share-utils.js";

const ROOM_STORAGE_KEY = "room";
const JSON_REQUEST_LIMIT = 96 * 1024;
const MULTIPART_OVERHEAD_ALLOWANCE = 256 * 1024;

function jsonResponse(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function ok(data, status = 200) {
  return jsonResponse(status, { ok: true, data });
}

function error(status, code, message, details) {
  const payload = { ok: false, error: { code, message } };
  if (details !== undefined) payload.error.details = details;
  return jsonResponse(status, payload);
}

function limitsFromEnv(env) {
  const maxFileBytes = envInteger(
    env.SHARE_MAX_FILE_BYTES,
    DEFAULT_SHARE_LIMITS.maxFileBytes,
    { min: 1024, max: 100 * 1024 * 1024 }
  );
  const maxRoomBytes = envInteger(
    env.SHARE_MAX_ROOM_BYTES,
    DEFAULT_SHARE_LIMITS.maxRoomBytes,
    { min: maxFileBytes, max: 1024 * 1024 * 1024 }
  );

  return {
    maxPayloadBytes: envInteger(
      env.SHARE_MAX_PAYLOAD_BYTES,
      DEFAULT_SHARE_LIMITS.maxPayloadBytes,
      { min: 1024, max: 1024 * 1024 }
    ),
    maxFileMetaBytes: envInteger(
      env.SHARE_MAX_FILE_META_BYTES,
      DEFAULT_SHARE_LIMITS.maxFileMetaBytes,
      { min: 256, max: 64 * 1024 }
    ),
    maxFileBytes,
    maxRoomBytes,
    maxFiles: envInteger(env.SHARE_MAX_FILES, DEFAULT_SHARE_LIMITS.maxFiles, {
      min: 1,
      max: 100
    })
  };
}

function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    meta: file.meta ?? null,
    createdAt: file.createdAt
  };
}

function publicRoom(room) {
  return {
    roomId: room.roomId,
    mode: room.mode ?? "private",
    crypto: room.crypto ?? null,
    collaborative: Boolean(room.collaborative),
    publicWritable: Boolean(room.publicWritable),
    legacy: (room.schemaVersion ?? 1) < 2,
    payload: room.payload ?? null,
    revision: room.revision ?? 0,
    files: (room.files ?? []).map(publicFile),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    expiresAt: room.expiresAt,
    ttlSeconds: Math.max(0, Math.ceil((room.expiresAt - room.createdAt) / 1000))
  };
}

function expired(room, now = Date.now()) {
  return room.expiresAt <= now;
}

function parseMetadata(value, maxBytes) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new TypeError("File metadata must be a JSON string.");
  }
  if (utf8ByteLength(value) > maxBytes) throw new BodyTooLargeError("File metadata is too large.");
  return JSON.parse(value);
}

function rawUploadName(request, url) {
  const fromQuery = url.searchParams.get("name");
  const fromHeader = request.headers.get("x-file-name");
  if (fromQuery) return fromQuery;
  if (!fromHeader) return "shared-file.bin";
  try {
    return decodeURIComponent(fromHeader);
  } catch {
    return fromHeader;
  }
}

function uploadType(value) {
  const type = String(value ?? "application/octet-stream").trim();
  return /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/i.test(type)
    ? type.toLowerCase()
    : "application/octet-stream";
}

export class ShareRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      if (url.pathname === "/create" && request.method === "POST") {
        return await this.create(request);
      }
      if (url.pathname === "/room") {
        if (request.method === "GET") return await this.getRoom();
        if (request.method === "DELETE") return await this.deleteRoom(request);
      }
      if (url.pathname === "/text" && request.method === "PUT") {
        return await this.putText(request);
      }
      if (url.pathname === "/files" && request.method === "POST") {
        return await this.uploadFile(request, url);
      }
      if (parts.length === 2 && parts[0] === "files" && isValidFileId(parts[1])) {
        if (request.method === "GET" || request.method === "HEAD") {
          return await this.downloadFile(parts[1], request.method === "HEAD");
        }
        if (request.method === "DELETE") return await this.deleteFile(parts[1], request);
      }

      return error(404, "NOT_FOUND", "Share API route not found.");
    } catch (caught) {
      if (caught instanceof BodyTooLargeError) {
        return error(413, "PAYLOAD_TOO_LARGE", caught.message);
      }
      if (caught instanceof SyntaxError || caught instanceof TypeError || caught instanceof RangeError) {
        return error(400, "INVALID_REQUEST", caught.message);
      }
      console.error("ShareRoom request failed", caught);
      return error(500, "INTERNAL_ERROR", "The share service could not complete the request.");
    }
  }

  async alarm() {
    try {
      const room = await this.ctx.storage.get(ROOM_STORAGE_KEY);
      if (!room) return;
      if (!expired(room)) {
        await this.ctx.storage.setAlarm(room.expiresAt);
        return;
      }
      await this.cleanup(room);
    } catch (caught) {
      console.error("ShareRoom cleanup alarm failed", caught);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      throw caught;
    }
  }

  async create(request) {
    const body = await readJsonWithLimit(request, 4096);
    const ownerTokenHash = body?.ownerTokenHash ?? body?.writeTokenHash;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.roomId !== "string" ||
      !/^[a-f0-9]{64}$/i.test(body.writeTokenHash ?? "") ||
      !/^[a-f0-9]{64}$/i.test(ownerTokenHash ?? "") ||
      !["private", "convenience"].includes(body.mode) ||
      (body.crypto !== null && jsonByteLength(body.crypto) > 2048) ||
      !Number.isSafeInteger(body.expiresAt)
    ) {
      return error(400, "INVALID_REQUEST", "Invalid internal room creation request.");
    }

    const existing = await this.ctx.storage.get(ROOM_STORAGE_KEY);
    if (existing && !expired(existing)) {
      return error(409, "ROOM_EXISTS", "That room already exists.");
    }
    if (existing) await this.cleanup(existing);

      const now = Date.now();
      const room = {
        schemaVersion: 2,
        roomId: body.roomId,
        mode: body.mode,
        crypto: body.crypto ?? null,
        collaborative: Boolean(body.collaborative),
        publicWritable: Boolean(body.publicWritable),
        writeTokenHash: body.writeTokenHash.toLowerCase(),
        ownerTokenHash: ownerTokenHash.toLowerCase(),
        payload: null,
        revision: 0,
        files: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: body.expiresAt
      };
      await this.ctx.storage.put(ROOM_STORAGE_KEY, room);
      await this.ctx.storage.setAlarm(room.expiresAt);
      return ok(publicRoom(room), 201);
  }

  async loadRoom() {
    const room = await this.ctx.storage.get(ROOM_STORAGE_KEY);
    if (!room) return { response: error(404, "ROOM_NOT_FOUND", "Room not found.") };
    if (expired(room)) {
      await this.cleanup(room);
      return { response: error(410, "ROOM_EXPIRED", "This room has expired.") };
    }
    return { room };
  }

  async requestTokenHash(request) {
    const token = parseBearerToken(request.headers.get("authorization"));
    return token ? await sha256Hex(token) : null;
  }

  canWrite(room, tokenHash) {
    if (room.publicWritable) return true;
    if (!tokenHash) return false;
    const writeMatch = constantTimeEqual(tokenHash, room.writeTokenHash);
    const ownerMatch = constantTimeEqual(
      tokenHash,
      room.ownerTokenHash ?? room.writeTokenHash
    );
    return writeMatch || ownerMatch;
  }

  canOwn(room, tokenHash) {
    if (!tokenHash) return false;
    return constantTimeEqual(tokenHash, room.ownerTokenHash ?? room.writeTokenHash);
  }

  async getRoom() {
    const loaded = await this.loadRoom();
    if (loaded.response) return loaded.response;
    return ok(publicRoom(loaded.room));
  }

  async putText(request) {
    const loaded = await this.loadRoom();
    if (loaded.response) return loaded.response;
    const tokenHash = await this.requestTokenHash(request);
    if (!this.canWrite(loaded.room, tokenHash)) {
      return error(401, "UNAUTHORIZED", "A valid room write token is required.");
    }

    const body = await readJsonWithLimit(request, JSON_REQUEST_LIMIT);
    if (!body || typeof body !== "object" || Array.isArray(body) || !("payload" in body)) {
      return error(400, "INVALID_REQUEST", "A JSON payload field is required.");
    }
    const limits = limitsFromEnv(this.env);
    if (jsonByteLength(body.payload) > limits.maxPayloadBytes) {
      return error(413, "PAYLOAD_TOO_LARGE", "Clipboard payload exceeds the room limit.", {
        maxBytes: limits.maxPayloadBytes
      });
    }
    if (
      body.revision !== undefined &&
      (!Number.isSafeInteger(body.revision) || body.revision < 0)
    ) {
      return error(400, "INVALID_REVISION", "revision must be a non-negative integer.");
    }

    return await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get(ROOM_STORAGE_KEY);
      if (!current) return error(404, "ROOM_NOT_FOUND", "Room not found.");
      if (expired(current)) return error(410, "ROOM_EXPIRED", "This room has expired.");
      if (!this.canWrite(current, tokenHash)) {
        return error(401, "UNAUTHORIZED", "A valid room write token is required.");
      }
      if (body.revision !== undefined && body.revision !== current.revision) {
        return error(409, "REVISION_CONFLICT", "The room was updated by another client.", {
          revision: current.revision,
          updatedAt: current.updatedAt
        });
      }

      current.payload = body.payload;
      current.revision += 1;
      current.updatedAt = Date.now();
      transaction.put(ROOM_STORAGE_KEY, current);
      return ok(publicRoom(current));
    });
  }

  async readUpload(request, url, limits) {
    const contentType = request.headers.get("content-type") ?? "";
    const requestLength = Number(request.headers.get("content-length"));
    const multipart = contentType.toLowerCase().startsWith("multipart/form-data");

    if (
      Number.isFinite(requestLength) &&
      requestLength >
        limits.maxFileBytes + limits.maxFileMetaBytes + MULTIPART_OVERHEAD_ALLOWANCE
    ) {
      throw new BodyTooLargeError("File upload exceeds the room limit.");
    }

    if (multipart) {
      const form = await request.formData();
      const file = form.get("file");
      if (
        !file ||
        typeof file.stream !== "function" ||
        !Number.isSafeInteger(file.size)
      ) {
        throw new TypeError("multipart/form-data must include a file field.");
      }
      const meta = parseMetadata(form.get("meta"), limits.maxFileMetaBytes);
      return {
        body: file.stream(),
        declaredSize: file.size,
        name: sanitizeFileName(file.name),
        type: uploadType(file.type),
        meta
      };
    }

    if (!request.body) throw new TypeError("A file request body is required.");
    const meta = parseMetadata(
      request.headers.get("x-file-meta"),
      limits.maxFileMetaBytes
    );
    return {
      body: request.body,
      declaredSize: Number.isFinite(requestLength) ? requestLength : null,
      name: sanitizeFileName(rawUploadName(request, url)),
      type: uploadType(request.headers.get("x-file-type") ?? contentType),
      meta
    };
  }

  async uploadFile(request, url) {
    if (!this.env.SHARE_FILES) {
      return error(503, "STORAGE_NOT_CONFIGURED", "File storage is not configured.");
    }
    const loaded = await this.loadRoom();
    if (loaded.response) return loaded.response;
    const tokenHash = await this.requestTokenHash(request);
    if (!this.canWrite(loaded.room, tokenHash)) {
      return error(401, "UNAUTHORIZED", "A valid room write token is required.");
    }

    const limits = limitsFromEnv(this.env);
    if (loaded.room.files.length >= limits.maxFiles) {
      return error(409, "FILE_LIMIT_REACHED", "This room has reached its file count limit.", {
        maxFiles: limits.maxFiles
      });
    }

    const upload = await this.readUpload(request, url, limits);
    if (upload.declaredSize !== null && upload.declaredSize > limits.maxFileBytes) {
      return error(413, "FILE_TOO_LARGE", "File exceeds the per-file limit.", {
        maxBytes: limits.maxFileBytes
      });
    }
    const currentBytes = loaded.room.files.reduce((sum, file) => sum + file.size, 0);
    if (
      upload.declaredSize !== null &&
      currentBytes + upload.declaredSize > limits.maxRoomBytes
    ) {
      return error(413, "ROOM_STORAGE_LIMIT", "File exceeds the room storage limit.", {
        maxBytes: limits.maxRoomBytes
      });
    }

    const fileId = randomBase64Url(15);
    const key = `${loaded.room.roomId}/${fileId}`;
    let stored;
    try {
      stored = await this.env.SHARE_FILES.put(key, upload.body, {
        httpMetadata: { contentType: "application/octet-stream" }
      });
    } catch (caught) {
      console.error("R2 upload failed", caught);
      return error(502, "FILE_STORAGE_ERROR", "The file could not be stored.");
    }

    let storedSize;
    try {
      storedSize = Number(stored?.size);
      if (!Number.isSafeInteger(storedSize)) {
        const head = await this.env.SHARE_FILES.head(key);
        storedSize = Number(head?.size);
      }
    } catch (caught) {
      console.error("R2 size verification failed", caught);
      try {
        await this.env.SHARE_FILES.delete(key);
      } catch (deleteError) {
        console.error("R2 upload rollback failed", deleteError);
      }
      return error(502, "FILE_STORAGE_ERROR", "Stored file size could not be verified.");
    }
    if (!Number.isSafeInteger(storedSize) || storedSize < 0) {
      await this.env.SHARE_FILES.delete(key);
      return error(502, "FILE_STORAGE_ERROR", "Stored file size could not be verified.");
    }
    if (storedSize > limits.maxFileBytes) {
      await this.env.SHARE_FILES.delete(key);
      return error(413, "FILE_TOO_LARGE", "File exceeds the per-file limit.", {
        maxBytes: limits.maxFileBytes
      });
    }

    const descriptor = {
      id: fileId,
      key,
      name: upload.name,
      size: storedSize,
      type: upload.type,
      meta: upload.meta,
      createdAt: Date.now()
    };
    let result;
    try {
      result = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get(ROOM_STORAGE_KEY);
      if (!current) return { response: error(404, "ROOM_NOT_FOUND", "Room not found.") };
      if (expired(current)) {
        return { response: error(410, "ROOM_EXPIRED", "This room has expired.") };
      }
      if (!this.canWrite(current, tokenHash)) {
        return {
          response: error(401, "UNAUTHORIZED", "A valid room write token is required.")
        };
      }
      const bytes = current.files.reduce((sum, file) => sum + file.size, 0);
      if (current.files.length >= limits.maxFiles) {
        return {
          response: error(409, "FILE_LIMIT_REACHED", "This room has reached its file count limit.")
        };
      }
      if (bytes + storedSize > limits.maxRoomBytes) {
        return {
          response: error(413, "ROOM_STORAGE_LIMIT", "File exceeds the room storage limit.")
        };
      }

      current.files.push(descriptor);
      current.updatedAt = Date.now();
      transaction.put(ROOM_STORAGE_KEY, current);
        return { room: current };
      });
    } catch (caught) {
      try {
        await this.env.SHARE_FILES.delete(key);
      } catch (deleteError) {
        console.error("R2 upload rollback failed", deleteError);
      }
      throw caught;
    }

    if (result.response) {
      await this.env.SHARE_FILES.delete(key);
      return result.response;
    }
    return ok({
      file: publicFile(descriptor),
      room: publicRoom(result.room)
    }, 201);
  }

  async downloadFile(fileId, headOnly) {
    if (!this.env.SHARE_FILES) {
      return error(503, "STORAGE_NOT_CONFIGURED", "File storage is not configured.");
    }
    const loaded = await this.loadRoom();
    if (loaded.response) return loaded.response;
    const file = loaded.room.files.find((candidate) => candidate.id === fileId);
    if (!file) return error(404, "FILE_NOT_FOUND", "File not found.");

    const object = await this.env.SHARE_FILES.get(file.key);
    if (!object) return error(404, "FILE_NOT_FOUND", "File not found.");

    const headers = new Headers({
      "content-type": file.type || "application/octet-stream",
      "content-length": String(object.size),
      "content-disposition": contentDisposition(file.name),
      "cache-control": "private, no-store"
    });
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    return new Response(headOnly ? null : object.body, { status: 200, headers });
  }

  async deleteFile(fileId, request) {
    if (!this.env.SHARE_FILES) {
      return error(503, "STORAGE_NOT_CONFIGURED", "File storage is not configured.");
    }
    const loaded = await this.loadRoom();
    if (loaded.response) return loaded.response;
    const tokenHash = await this.requestTokenHash(request);
    if (!this.canWrite(loaded.room, tokenHash)) {
      return error(401, "UNAUTHORIZED", "A valid room write token is required.");
    }
    const file = loaded.room.files.find((candidate) => candidate.id === fileId);
    if (!file) return error(404, "FILE_NOT_FOUND", "File not found.");

    try {
      await this.env.SHARE_FILES.delete(file.key);
    } catch (caught) {
      console.error("R2 delete failed", caught);
      return error(502, "FILE_STORAGE_ERROR", "The file could not be deleted.");
    }

    return await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get(ROOM_STORAGE_KEY);
      if (!current) return error(404, "ROOM_NOT_FOUND", "Room not found.");
      if (expired(current)) return error(410, "ROOM_EXPIRED", "This room has expired.");
      if (!this.canWrite(current, tokenHash)) {
        return error(401, "UNAUTHORIZED", "A valid room write token is required.");
      }
      current.files = current.files.filter((candidate) => candidate.id !== fileId);
      current.updatedAt = Date.now();
      transaction.put(ROOM_STORAGE_KEY, current);
      return ok({ fileId, room: publicRoom(current) });
    });
  }

  async deleteRoom(request) {
    const loaded = await this.loadRoom();
    if (loaded.response) return loaded.response;
    const tokenHash = await this.requestTokenHash(request);
    if (!this.canOwn(loaded.room, tokenHash)) {
      return error(401, "UNAUTHORIZED", "The room owner token is required.");
    }

    try {
      await this.cleanup(loaded.room);
      return new Response(null, { status: 204 });
    } catch (caught) {
      console.error("Room deletion failed", caught);
      return error(502, "FILE_STORAGE_ERROR", "The room could not be deleted.");
    }
  }

  async cleanup(room) {
    const keys = (room.files ?? []).map((file) => file.key);
    if (keys.length) {
      if (!this.env.SHARE_FILES) throw new Error("R2 file storage binding is unavailable.");
      await this.env.SHARE_FILES.delete(keys);
    }
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}
