import { describe, expect, it } from "vitest";
import { ShareRoom } from "./share-room.js";
import { sha256Hex } from "./share-utils.js";

function harness() {
  const values = new Map();
  const deletedObjects = [];
  const objects = new Map();
  const storage = {
    alarm: null,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async setAlarm(value) { this.alarm = value; },
    async deleteAlarm() { this.alarm = null; },
    async deleteAll() { values.clear(); },
    async transaction(callback) {
      return callback({
        async get(key) { return values.get(key); },
        put(key, value) { values.set(key, structuredClone(value)); }
      });
    }
  };
  const env = {
    SHARE_MAX_FILE_BYTES: "26214400",
    SHARE_MAX_ROOM_BYTES: "104857600",
    SHARE_MAX_FILES: "10",
    SHARE_FILES: {
      async put(key, body) {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        objects.set(key, bytes);
        return { size: bytes.byteLength };
      },
      async head(key) {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.byteLength } : null;
      },
      async get(key) {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.byteLength, body: bytes, httpEtag: "etag" } : null;
      },
      async delete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          deletedObjects.push(key);
          objects.delete(key);
        }
      }
    }
  };
  return {
    room: new ShareRoom({ storage }, env),
    storage,
    values,
    objects,
    deletedObjects
  };
}

async function createInternal(room, values) {
  return room.fetch(new Request("https://share.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values)
  }));
}

describe("ShareRoom permissions and destruction", () => {
  it("allows convenience collaborators to write but reserves destruction for the owner", async () => {
    const test = harness();
    const ownerToken = "O".repeat(43);
    const ownerTokenHash = await sha256Hex(ownerToken);
    const created = await createInternal(test.room, {
      roomId: "team-demo",
      mode: "convenience",
      crypto: null,
      collaborative: true,
      publicWritable: true,
      writeTokenHash: ownerTokenHash,
      ownerTokenHash,
      expiresAt: Date.now() + 300000
    });
    expect(created.status).toBe(201);

    const saved = await test.room.fetch(new Request("https://share.internal/text", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "plain shared text", revision: 0 })
    }));
    expect(saved.status).toBe(200);

    const uploaded = await test.room.fetch(new Request("https://share.internal/files", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "demo.txt",
        "x-file-type": "text/plain"
      },
      body: new TextEncoder().encode("shared file")
    }));
    expect(uploaded.status).toBe(201);
    expect(test.objects.size).toBe(1);

    const denied = await test.room.fetch(new Request("https://share.internal/room", {
      method: "DELETE"
    }));
    expect(denied.status).toBe(401);

    const destroyed = await test.room.fetch(new Request("https://share.internal/room", {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerToken}` }
    }));
    expect(destroyed.status).toBe(204);
    expect(test.values.size).toBe(0);
    expect(test.objects.size).toBe(0);
    expect(test.deletedObjects).toHaveLength(1);
  });

  it("accepts a password-derived collaborator token but not for owner destruction", async () => {
    const test = harness();
    const ownerToken = "A".repeat(43);
    const collaboratorToken = "B".repeat(43);
    const created = await createInternal(test.room, {
      roomId: "private-demo",
      mode: "private",
      crypto: {
        scheme: "password-v1",
        kdf: "PBKDF2-HMAC-SHA256",
        salt: "S".repeat(22),
        iterations: 600000,
        check: { v: 1, alg: "A256GCM", iv: "I".repeat(16), data: "D".repeat(32) }
      },
      collaborative: true,
      publicWritable: false,
      writeTokenHash: await sha256Hex(collaboratorToken),
      ownerTokenHash: await sha256Hex(ownerToken),
      expiresAt: Date.now() + 900000
    });
    expect(created.status).toBe(201);

    const saved = await test.room.fetch(new Request("https://share.internal/text", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${collaboratorToken}`
      },
      body: JSON.stringify({ payload: { v: 1, alg: "A256GCM", iv: "x", data: "y" } })
    }));
    expect(saved.status).toBe(200);

    const denied = await test.room.fetch(new Request("https://share.internal/room", {
      method: "DELETE",
      headers: { authorization: `Bearer ${collaboratorToken}` }
    }));
    expect(denied.status).toBe(401);

    const destroyed = await test.room.fetch(new Request("https://share.internal/room", {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerToken}` }
    }));
    expect(destroyed.status).toBe(204);
  });
});