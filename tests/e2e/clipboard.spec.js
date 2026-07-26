import { expect, test } from "@playwright/test";
import {
  createPasswordRoomSecrets,
  encryptText,
  exportShareKey,
  generateShareKey
} from "../../src/clipboard-crypto.js";

function json(route, status, data) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data })
  });
}

test("隐私短房间使用 15 分钟、浏览器加密，并可由房主主动销毁", async ({ page }) => {
  const ownerToken = "O".repeat(43);
  let room = null;
  let createRequest = null;
  let savedRequest = null;
  let uploadedRequest = null;
  let destroyRequest = null;

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { globalThis.__copiedPassword = value; } }
    });
  });
  await page.route("**/api/share/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/share/rooms") {
      createRequest = request.postDataJSON();
      const now = Date.now();
      room = {
        roomId: createRequest.roomId,
        mode: createRequest.mode,
        crypto: createRequest.crypto,
        collaborative: createRequest.collaborative,
        publicWritable: false,
        legacy: false,
        payload: null,
        revision: 0,
        files: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + createRequest.ttlSeconds * 1000,
        ttlSeconds: createRequest.ttlSeconds
      };
      return json(route, 201, { ...room, ownerToken, writeToken: ownerToken });
    }
    if (request.method() === "GET" && url.pathname === `/api/share/rooms/${room?.roomId}`) {
      return json(route, 200, room);
    }
    if (request.method() === "PUT" && url.pathname.endsWith("/text")) {
      const body = request.postDataJSON();
      savedRequest = { body, authorization: request.headers().authorization };
      room.payload = body.payload;
      room.revision += 1;
      room.updatedAt = Date.now();
      return json(route, 200, room);
    }
    if (request.method() === "POST" && url.pathname.endsWith("/files")) {
      const headers = request.headers();
      const body = request.postDataBuffer();
      uploadedRequest = { headers, body };
      const file = {
        id: "PrivateFileId1234",
        name: headers["x-file-name"],
        type: headers["x-file-type"],
        size: body.length,
        meta: JSON.parse(headers["x-file-meta"]),
        createdAt: Date.now()
      };
      room.files.push(file);
      return json(route, 201, { file, room });
    }
    if (request.method() === "DELETE" && url.pathname === `/api/share/rooms/${room?.roomId}`) {
      destroyRequest = { authorization: request.headers().authorization };
      room = null;
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });

  await page.goto("/clipboard/");
  await page.getByRole("textbox", { name: "房间名称", exact: true }).fill("Team-Demo");
  await page.locator('[data-role="password"]').fill("correct horse battery staple");
  await page.getByLabel("保留时间").selectOption("900");
  await page.getByRole("button", { name: "创建隐私房间" }).click();

  await expect(page).toHaveURL(/\/clipboard\/r\/team-demo$/);
  await expect(page.getByText("隐私房间", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "销毁房间" })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制密码" })).toBeVisible();
  await page.getByRole("button", { name: "复制密码" }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__copiedPassword))
    .toBe("correct horse battery staple");
  expect(createRequest).toMatchObject({
    roomId: "team-demo",
    mode: "private",
    collaborative: true,
    ttlSeconds: 900
  });
  expect(createRequest.crypto).toMatchObject({
    scheme: "password-v1",
    kdf: "PBKDF2-HMAC-SHA256",
    iterations: 600000
  });
  expect(createRequest.writeTokenHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(createRequest)).not.toContain("correct horse battery staple");

  const note = page.getByRole("textbox", { name: "共享文字" });
  await note.fill("这段私密文字不能出现在请求体里");
  await expect.poll(() => savedRequest).not.toBeNull();
  expect(savedRequest.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
  expect(savedRequest.authorization).not.toBe(`Bearer ${ownerToken}`);
  expect(savedRequest.body.payload).toMatchObject({ v: 1, alg: "A256GCM" });
  expect(JSON.stringify(savedRequest.body)).not.toContain("这段私密文字");

  await page.locator('[data-role="files"]').setInputFiles({
    name: "secret.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("private file body must be encrypted")
  });
  await expect.poll(() => uploadedRequest).not.toBeNull();
  expect(uploadedRequest.headers["x-file-name"]).toBe("encrypted.bin");
  expect(uploadedRequest.headers["x-file-meta"]).toContain('"alg":"A256GCM"');
  expect(uploadedRequest.body.toString("utf8")).not.toContain("private file body");
  await expect(page.getByText("secret.txt", { exact: true })).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "销毁房间" }).click();
  await expect.poll(() => destroyRequest).not.toBeNull();
  expect(destroyRequest.authorization).toBe(`Bearer ${ownerToken}`);
  await expect(page.locator('[data-view="entry"]')).toBeVisible();
});

test("便捷模式生成短链接，支持自定义 7 分钟和无令牌协作", async ({ page }) => {
  const ownerToken = "P".repeat(43);
  let room = null;
  let createRequest = null;
  let uploadedRequest = null;
  const savedRequests = [];

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { globalThis.__copiedLink = value; } }
    });
  });
  await page.route("**/api/share/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/share/rooms") {
      createRequest = request.postDataJSON();
      const now = Date.now();
      room = {
        roomId: createRequest.roomId,
        mode: "convenience",
        crypto: null,
        collaborative: createRequest.collaborative,
        publicWritable: true,
        legacy: false,
        payload: "",
        revision: 0,
        files: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + createRequest.ttlSeconds * 1000
      };
      return json(route, 201, { ...room, ownerToken, writeToken: ownerToken });
    }
    if (request.method() === "GET" && url.pathname === `/api/share/rooms/${room?.roomId}`) {
      return json(route, 200, room);
    }
    if (request.method() === "PUT" && url.pathname.endsWith("/text")) {
      const body = request.postDataJSON();
      savedRequests.push({ body, authorization: request.headers().authorization });
      room.payload = body.payload;
      room.revision += 1;
      return json(route, 200, room);
    }
    if (request.method() === "POST" && url.pathname.endsWith("/files")) {
      const headers = request.headers();
      const body = request.postDataBuffer();
      uploadedRequest = { headers, body };
      const file = {
        id: "PublicFileId12345",
        name: decodeURIComponent(headers["x-file-name"]),
        type: headers["x-file-type"],
        size: body.length,
        meta: null,
        createdAt: Date.now()
      };
      room.files.push(file);
      return json(route, 201, { file, room });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });

  await page.goto("/clipboard/");
  await page.locator('input[name="room-mode"][value="convenience"]').check();
  await page.getByRole("textbox", { name: "房间名称", exact: true }).fill("quick-note");
  await page.getByLabel("保留时间").selectOption("custom");
  await page.getByLabel("自定义分钟数").fill("7");
  await page.getByRole("button", { name: "创建便捷房间" }).click();

  expect(createRequest).toMatchObject({
    roomId: "quick-note",
    mode: "convenience",
    collaborative: true,
    ttlSeconds: 420,
    crypto: null
  });
  await page.getByRole("button", { name: "复制房间链接" }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__copiedLink)).toBe(
    "https://c.136136136.xyz/quick-note"
  );

  await page.evaluate(() => sessionStorage.clear());
  await page.getByRole("button", { name: "退出" }).click();
  await page.getByRole("textbox", { name: "房间名称或链接" }).fill("quick-note");
  await page.getByRole("button", { name: "打开房间" }).click();
  const note = page.getByRole("textbox", { name: "共享文字" });
  await expect(note).toBeEditable();
  await note.fill("普通跨设备文本");
  await expect.poll(() => savedRequests.length).toBeGreaterThan(0);
  const saved = savedRequests.at(-1);
  expect(saved.body.payload).toBe("普通跨设备文本");
  expect(saved.authorization).toBeUndefined();

  await page.locator('[data-role="files"]').setInputFiles({
    name: "公开资料.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("plain convenience file")
  });
  await expect.poll(() => uploadedRequest).not.toBeNull();
  expect(decodeURIComponent(uploadedRequest.headers["x-file-name"])).toBe("公开资料.txt");
  expect(uploadedRequest.headers.authorization).toBeUndefined();
  expect(uploadedRequest.body.toString("utf8")).toBe("plain convenience file");
  await expect(page.getByText("公开资料.txt", { exact: true })).toBeVisible();
});

test("隐私短房间使用密码解锁，协作者可编辑但不能看到房主令牌", async ({ page }) => {
  const password = "another private password";
  const secrets = await createPasswordRoomSecrets(password, 1000);
  const roomId = "private-demo";
  const room = {
    roomId,
    mode: "private",
    crypto: secrets.crypto,
    collaborative: true,
    publicWritable: false,
    legacy: false,
    payload: await encryptText("加密后的初始内容", secrets.key),
    revision: 1,
    files: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 900000
  };
  let savedRequest = null;

  await page.route("**/api/share/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === `/api/share/rooms/${roomId}`) {
      return json(route, 200, room);
    }
    if (request.method() === "PUT" && url.pathname.endsWith("/text")) {
      savedRequest = {
        body: request.postDataJSON(),
        authorization: request.headers().authorization
      };
      room.revision += 1;
      return json(route, 200, room);
    }
    return route.fulfill({ status: 404, body: "not found" });
  });

  await page.goto("/clipboard/");
  await page.getByRole("textbox", { name: "房间名称或链接" }).fill(roomId);
  await page.getByRole("button", { name: "打开房间" }).click();
  await expect(page.locator('[data-view="unlock"]')).toBeVisible();

  await page.getByLabel("解锁密码").fill("definitely wrong");
  await page.getByRole("button", { name: "解锁并进入" }).click();
  await expect(page.locator('[data-role="status"]')).toContainText("房间密码不正确");

  await page.getByLabel("解锁密码").fill(password);
  await page.getByRole("button", { name: "解锁并进入" }).click();
  const note = page.getByRole("textbox", { name: "共享文字" });
  await expect(note).toHaveValue("加密后的初始内容");
  await expect(note).toBeEditable();
  await expect(page.getByRole("button", { name: "销毁房间" })).toBeHidden();

  await note.fill("协作者的新内容");
  await expect.poll(() => savedRequest).not.toBeNull();
  expect(savedRequest.authorization).toBe(`Bearer ${secrets.writeToken}`);
  expect(JSON.stringify(savedRequest.body)).not.toContain("协作者的新内容");
});

test("原有密钥链接仍然可以进入和编辑旧房间", async ({ page }) => {
  const roomId = "AbCdEfGhJkMnPqRsTuVwXyZ2";
  const encodedKey = await exportShareKey(await generateShareKey());
  const writeToken = "editor-token-for-legacy-room";
  const room = {
    roomId,
    payload: null,
    revision: 0,
    files: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 3600000
  };
  let savedRequest = null;

  await page.route("**/api/share/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === `/api/share/rooms/${roomId}`) {
      return json(route, 200, room);
    }
    if (request.method() === "PUT" && url.pathname.endsWith("/text")) {
      savedRequest = {
        body: request.postDataJSON(),
        authorization: request.headers().authorization
      };
      room.revision += 1;
      return json(route, 200, room);
    }
    return route.fulfill({ status: 404, body: "not found" });
  });

  await page.goto("/clipboard/");
  const legacyUrl = `${page.url()}r/${roomId}#key=${encodedKey}&write=${writeToken}`;
  await page.getByRole("textbox", { name: "房间名称或链接" }).fill(legacyUrl);
  await page.getByRole("button", { name: "打开房间" }).click();
  const note = page.getByRole("textbox", { name: "共享文字" });
  await expect(note).toBeEditable();
  await note.fill("旧链接继续工作");

  await expect.poll(() => savedRequest).not.toBeNull();
  expect(savedRequest.authorization).toBe(`Bearer ${writeToken}`);
  expect(savedRequest.body.payload).toMatchObject({ v: 1, alg: "A256GCM" });
  await expect(page).toHaveURL(new RegExp(`/clipboard/r/${roomId}#key=`));
});