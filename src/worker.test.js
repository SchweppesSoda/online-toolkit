import { describe, expect, it } from "vitest";
import worker from "./worker.js";
import { sha256Hex } from "./share-utils.js";

function cryptoMetadata() {
  return {
    scheme: "password-v1",
    kdf: "PBKDF2-HMAC-SHA256",
    salt: "A".repeat(22),
    iterations: 600000,
    check: { v: 1, alg: "A256GCM", iv: "B".repeat(16), data: "C".repeat(32) }
  };
}

function fakeEnv(overrides = {}) {
  const captured = { objectName: "", create: null, assetPath: "" };
  const env = {
    SHARE_ALLOW_CUSTOM_ROOM_IDS: "true",
    SHARE_MIN_TTL_SECONDS: "300",
    SHARE_DEFAULT_TTL_SECONDS: "3600",
    SHARE_MAX_TTL_SECONDS: "86400",
    SHARE_SHORT_ORIGIN: "https://c.136136136.xyz",
    SHARE_ROOMS: {
      idFromName(name) {
        captured.objectName = name;
        return name;
      },
      get() {
        return {
          async fetch(input, init) {
            const request = input instanceof Request ? input : new Request(input, init);
            captured.create = await request.json();
            return Response.json({
              ok: true,
              data: {
                roomId: captured.create.roomId,
                mode: captured.create.mode,
                crypto: captured.create.crypto,
                collaborative: captured.create.collaborative,
                publicWritable: captured.create.publicWritable,
                revision: 0,
                files: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
                expiresAt: captured.create.expiresAt
              }
            }, { status: 201 });
          }
        };
      }
    },
    ASSETS: {
      async fetch(request) {
        captured.assetPath = new URL(request.url).pathname;
        return new Response("clipboard asset", { status: 200 });
      }
    },
    ...overrides
  };
  return { env, captured };
}

async function postRoom(env, body) {
  return worker.fetch(new Request("https://tools.136136136.xyz/api/share/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env);
}

describe("share worker room creation", () => {
  it("normalizes a custom private room and separates owner from password collaborators", async () => {
    const { env, captured } = fakeEnv();
    const collaboratorHash = "d".repeat(64);
    const response = await postRoom(env, {
      roomId: "Team-Demo",
      mode: "private",
      collaborative: true,
      ttlSeconds: 900,
      crypto: cryptoMetadata(),
      writeTokenHash: collaboratorHash
    });
    const result = await response.json();

    expect(response.status).toBe(201);
    expect(captured.objectName).toBe("named:team-demo");
    expect(captured.create).toMatchObject({
      roomId: "team-demo",
      mode: "private",
      collaborative: true,
      publicWritable: false,
      writeTokenHash: collaboratorHash
    });
    expect(captured.create.ownerTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(captured.create.ownerTokenHash).not.toBe(collaboratorHash);
    expect(result.data.ownerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("creates a five-minute convenience room that is writable through its short link", async () => {
    const { env, captured } = fakeEnv();
    const response = await postRoom(env, {
      roomId: "临时会议",
      mode: "convenience",
      collaborative: true,
      ttlSeconds: 300,
      crypto: null
    });
    const result = await response.json();

    expect(response.status).toBe(201);
    expect(captured.objectName).toBe("named:临时会议");
    expect(captured.create.publicWritable).toBe(true);
    expect(captured.create.writeTokenHash).toBe(captured.create.ownerTokenHash);
    expect(await sha256Hex(result.data.ownerToken)).toBe(captured.create.ownerTokenHash);
  });

  it("keeps the original random room API compatible", async () => {
    const { env, captured } = fakeEnv();
    const response = await postRoom(env, { ttlSeconds: 1800 });
    const result = await response.json();

    expect(response.status).toBe(201);
    expect(result.data.roomId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(captured.objectName).toBe(result.data.roomId);
    expect(captured.create).toMatchObject({
      mode: "private",
      crypto: null,
      collaborative: false,
      publicWritable: false
    });
  });
});

describe("short clipboard domain routing", () => {
  it("serves the clipboard application at the short root and named paths", async () => {
    const { env, captured } = fakeEnv();
    const rootResponse = await worker.fetch(new Request("https://c.136136136.xyz/"), env);
    expect(rootResponse.status).toBe(200);
    expect(captured.assetPath).toBe("/clipboard/");

    const roomResponse = await worker.fetch(
      new Request("https://c.136136136.xyz/team-demo"),
      env
    );
    expect(roomResponse.status).toBe(200);
    expect(captured.assetPath).toBe("/clipboard/");
  });
});