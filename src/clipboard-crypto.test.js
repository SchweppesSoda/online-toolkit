import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import("node:crypto");
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  }
  if (!globalThis.btoa) {
    globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
    globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");
  }
});

describe("share key", () => {
  it("exports a URL-safe 256-bit key", async () => {
    const { exportShareKey, generateShareKey, importShareKey } = await import("./clipboard-crypto.js");
    const encoded = await exportShareKey(await generateShareKey());
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await exportShareKey(await importShareKey(encoded))).toBe(encoded);
  });

  it("extracts the key without sending it in the URL path", async () => {
    const { hashForKey, keyFromHash } = await import("./clipboard-crypto.js");
    const key = "A".repeat(43);
    expect(keyFromHash(hashForKey(key))).toBe(key);
    expect(keyFromHash(`#${key}`)).toBe(key);
    expect(keyFromHash("?key=not-a-fragment")).toBe("");
  });
});

describe("AES-GCM payloads", () => {
  it("round-trips unicode text and JSON metadata", async () => {
    const {
      decryptJson,
      decryptText,
      encryptJson,
      encryptText,
      generateShareKey
    } = await import("./clipboard-crypto.js");
    const key = await generateShareKey();
    const textEnvelope = await encryptText("跨设备剪贴板\nhello", key);
    expect(textEnvelope).toMatchObject({ v: 1, alg: "A256GCM" });
    expect(await decryptText(textEnvelope, key)).toBe("跨设备剪贴板\nhello");

    const metadata = { name: "截图 01.png", type: "image/png", size: 2048 };
    expect(await decryptJson(await encryptJson(metadata, key), key)).toEqual(metadata);
  });

  it("rejects a different room key", async () => {
    const { decryptText, encryptText, generateShareKey } = await import("./clipboard-crypto.js");
    const encrypted = await encryptText("secret", await generateShareKey());
    await expect(decryptText(encrypted, await generateShareKey()))
      .rejects.toThrow("无法解密内容");
  });

  it("round-trips binary files without base64 expansion", async () => {
    const { decryptFile, encryptFile, generateShareKey } = await import("./clipboard-crypto.js");
    const key = await generateShareKey();
    const input = new Blob([Uint8Array.from([0, 255, 13, 10, 42])], { type: "image/png" });
    const encrypted = await encryptFile(input, key);
    expect(encrypted.size).toBe(input.size + 29);
    const output = await decryptFile(encrypted, key, input.type);
    expect(output.type).toBe("image/png");
    expect([...new Uint8Array(await output.arrayBuffer())]).toEqual([0, 255, 13, 10, 42]);
  });
});

describe("password-protected private rooms", () => {
  it("generates a readable 100-bit password", async () => {
    const { generateRoomPassword } = await import("./clipboard-crypto.js");
    const generated = Array.from({ length: 12 }, () => generateRoomPassword());
    expect(new Set(generated).size).toBe(generated.length);
    for (const password of generated) {
      const groups = password.split("-");
      expect(groups).toHaveLength(5);
      expect(groups.every((group) => /^[A-HJ-NP-Z2-9]{4}$/.test(group))).toBe(true);
    }
  });

  it("derives the same encryption and collaboration secrets without sending the password", async () => {
    const {
      createPasswordRoomSecrets,
      decryptText,
      encryptText,
      hashRoomToken,
      unlockPasswordRoom
    } = await import("./clipboard-crypto.js");
    const password = "跨设备 strong password";
    const created = await createPasswordRoomSecrets(password, 1000);
    const unlocked = await unlockPasswordRoom(password, created.crypto);
    const envelope = await encryptText("private note", created.key);

    expect(await decryptText(envelope, unlocked.key)).toBe("private note");
    expect(unlocked.writeToken).toBe(created.writeToken);
    expect(await hashRoomToken(created.writeToken)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(created.crypto)).not.toContain(password);
  });

  it("rejects a wrong private-room password", async () => {
    const { createPasswordRoomSecrets, unlockPasswordRoom } =
      await import("./clipboard-crypto.js");
    const created = await createPasswordRoomSecrets("correct horse battery", 1000);
    await expect(unlockPasswordRoom("wrong password value", created.crypto))
      .rejects.toThrow("房间密码不正确");
  });
});