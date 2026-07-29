import {
  createPasswordRoomSecrets,
  decryptFile,
  decryptJson,
  decryptText,
  encryptFile,
  encryptJson,
  encryptText,
  hashForKey,
  hashRoomToken,
  importShareKey,
  keyFromHash,
  generateRoomPassword,
  randomRoomId,
  unlockPasswordRoom
} from "./clipboard-crypto.js";
import {
  isLegacyRoomId,
  isValidCustomRoomId,
  normalizeCustomRoomId,
  normalizeRoomId
} from "./share-utils.js";

const DEFAULT_API_BASE = "/api/share";
const DEFAULT_SHORT_ORIGIN = "https://c.136136136.xyz";
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const CUSTOM_TTL_MINUTES = 5;
const CUSTOM_TTL_MAX_MINUTES = 24 * 60;

function shortHostname(shortOrigin = DEFAULT_SHORT_ORIGIN) {
  try {
    return new URL(shortOrigin).hostname.toLowerCase();
  } catch {
    return new URL(DEFAULT_SHORT_ORIGIN).hostname;
  }
}

function roomFromPath(
  pathname = globalThis.location?.pathname || "",
  hostname = globalThis.location?.hostname || "",
  shortOrigin = DEFAULT_SHORT_ORIGIN
) {
  const legacyMatch = pathname.match(/\/clipboard\/r\/([^/?#]+)/);
  if (legacyMatch) {
    try {
      return normalizeRoomId(decodeURIComponent(legacyMatch[1]));
    } catch {
      return "";
    }
  }
  if (String(hostname).toLowerCase() !== shortHostname(shortOrigin)) return "";
  const shortMatch = pathname.match(/^\/([^/?#]+)\/?$/);
  if (!shortMatch) return "";
  try {
    const roomId = normalizeRoomId(decodeURIComponent(shortMatch[1]));
    return roomId && !isLegacyRoomId(roomId) ? roomId : "";
  } catch {
    return "";
  }
}

function tokenFromHash(hash = globalThis.location?.hash || "", name = "write") {
  return new URLSearchParams(String(hash).replace(/^#/, "")).get(name) || "";
}

function validRoomId(value) {
  return normalizeRoomId(value) !== "";
}

function bytesLabel(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function normalizeTime(value) {
  if (!value) return 0;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function expiryLabel(expiresAt) {
  const remaining = normalizeTime(expiresAt) - Date.now();
  if (remaining <= 0) return "已过期";
  const minutes = Math.ceil(remaining / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} 小时后`;
  return `${Math.ceil(hours / 24)} 天后`;
}

function ttlSeconds(preset, customMinutes) {
  if (preset !== "custom") {
    const seconds = Number(preset);
    if (Number.isSafeInteger(seconds) && seconds >= 300 && seconds <= 86400) return seconds;
    throw new Error("保留时间不正确");
  }
  const minutes = Number(customMinutes);
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < CUSTOM_TTL_MINUTES ||
    minutes > CUSTOM_TTL_MAX_MINUTES
  ) {
    throw new Error("自定义时间需要填写 5～1440 分钟的整数");
  }
  return minutes * 60;
}

function safeStorageGet(key) {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function safeStorageSet(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Private browsing can make sessionStorage unavailable. The room remains usable.
  }
}

function responsePayload(value) {
  return value?.data ?? value?.result ?? value;
}

class ApiError extends Error {
  constructor(message, status, code = "", details = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function payloadEnvelope(value) {
  if (!value) return null;
  if (value.v && value.iv && value.data) return value;
  return value.payload || value.envelope || null;
}

function plainRoomCandidate(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /[/:#?]/.test(trimmed)) return "";
  return normalizeRoomId(trimmed);
}

function roomReference(value, shortOrigin = DEFAULT_SHORT_ORIGIN) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return {};
  const plain = plainRoomCandidate(trimmed);
  if (plain) return { roomId: plain, encodedKey: "", writeToken: "", ownerToken: "" };
  try {
    const url = new URL(trimmed, globalThis.location?.href || "https://local.invalid/clipboard");
    return {
      roomId: roomFromPath(url.pathname, url.hostname, shortOrigin) ||
        normalizeRoomId(url.searchParams.get("room") || ""),
      encodedKey: keyFromHash(url.hash),
      writeToken: tokenFromHash(url.hash, "write"),
      ownerToken: tokenFromHash(url.hash, "owner")
    };
  } catch {
    const [roomId, hash = ""] = trimmed.split("#", 2);
    return {
      roomId: normalizeRoomId(roomId),
      encodedKey: keyFromHash(hash ? `#${hash}` : ""),
      writeToken: tokenFromHash(hash ? `#${hash}` : "", "write"),
      ownerToken: tokenFromHash(hash ? `#${hash}` : "", "owner")
    };
  }
}

function template() {
  return `
    <section class="clipboard-tool" aria-labelledby="clipboard-title">
      <div class="clipboard-hero">
        <div>
          <p class="clipboard-eyebrow">CROSS-DEVICE DROP</p>
          <h1 id="clipboard-title">云笺<em> · 临时中转</em></h1>
          <p class="clipboard-lead">自定义一个记得住的短房间名。普通内容直接传，敏感内容用密码在浏览器端加密。</p>
        </div>
        <div class="clipboard-security">
          <span class="clipboard-lock" aria-hidden="true">◇</span>
          <div><strong>便捷与隐私，两种模式</strong><span>隐私模式的密码和解密密钥不会发送给 Worker</span></div>
        </div>
      </div>

      <div class="clipboard-entry" data-view="entry">
        <section class="clipboard-entry-card clipboard-create-card" aria-labelledby="clipboard-create-title">
          <p class="clipboard-card-no">01 / CREATE</p>
          <h2 id="clipboard-create-title">新建临时房间</h2>
          <p data-role="mode-help">隐私模式使用独立密码端到端加密，分享短链接时请另行告知密码。</p>

          <fieldset class="clipboard-mode-picker">
            <legend>房间模式</legend>
            <label class="clipboard-mode selected">
              <input type="radio" name="room-mode" value="private" checked />
              <span><b>隐私模式</b><small>密码加密 · 服务器只见密文</small></span>
            </label>
            <label class="clipboard-mode">
              <input type="radio" name="room-mode" value="convenience" />
              <span><b>便捷模式</b><small>短链接即开即用 · 服务器可读</small></span>
            </label>
          </fieldset>

          <label class="clipboard-field">
            <span>房间名称</span>
            <span class="clipboard-inline-field">
              <input type="text" maxlength="16" autocomplete="off" spellcheck="false"
                data-role="room-name" aria-label="房间名称" />
              <button type="button" data-action="random-name">换一个</button>
            </span>
            <small>3～16 位字母、数字、中文、短横线或下划线</small>
          </label>

          <div class="clipboard-field clipboard-password-field" data-role="password-field">
            <label for="clipboard-room-password">房间密码</label>
            <div class="clipboard-inline-field">
              <input id="clipboard-room-password" type="text" minlength="8" maxlength="128"
                autocomplete="new-password" autocapitalize="none" spellcheck="false"
                data-role="password" aria-label="房间密码" />
              <button type="button" data-action="toggle-password">隐藏</button>
            </div>
            <div class="clipboard-password-meta">
              <small>已自动生成强密码，可直接修改；不会进入链接或发送给服务器</small>
              <div class="clipboard-password-actions">
                <button type="button" data-action="generate-password">重新生成</button>
                <button type="button" data-action="copy-password">复制密码</button>
              </div>
            </div>
          </div>

          <div class="clipboard-time-grid">
            <label class="clipboard-field">
              <span>保留时间</span>
              <select data-role="ttl-preset" aria-label="保留时间">
                <option value="300">5 分钟</option>
                <option value="900">15 分钟</option>
                <option value="1800">30 分钟</option>
                <option value="3600" selected>1 小时</option>
                <option value="10800">3 小时</option>
                <option value="21600">6 小时</option>
                <option value="43200">12 小时</option>
                <option value="86400">24 小时</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            <label class="clipboard-field" data-role="custom-ttl-field" hidden>
              <span>分钟数</span>
              <input type="number" min="5" max="1440" step="1" value="15"
                data-role="ttl-custom" aria-label="自定义分钟数" />
            </label>
          </div>

          <label class="clipboard-check">
            <input type="checkbox" data-role="collaborative" checked />
            <span><b data-role="collaborative-title">知道密码的人可以编辑</b><small>关闭后只有当前创建者可以修改内容</small></span>
          </label>

          <button class="clipboard-button primary" type="button" data-action="create">创建隐私房间</button>
        </section>

        <section class="clipboard-entry-card clipboard-join-card" aria-labelledby="clipboard-join-title">
          <p class="clipboard-card-no">02 / JOIN</p>
          <h2 id="clipboard-join-title">加入已有房间</h2>
          <p>输入房间名称或粘贴完整链接。隐私房间会在下一步询问密码。</p>
          <form data-role="join-form">
            <label class="clipboard-field">
              <span>房间名称或链接</span>
              <input type="text" inputmode="url" autocomplete="off" spellcheck="false"
                data-role="room-input" placeholder="demo 或 https://c.136136136.xyz/demo" />
            </label>
            <button class="clipboard-button secondary" type="submit">打开房间</button>
          </form>
          <aside class="clipboard-join-note">
            <b>短地址</b>
            <code>c.136136136.xyz/房间名</code>
            <span>名称越简单越容易被猜到；敏感内容请务必选择隐私模式。</span>
          </aside>
        </section>
      </div>

      <section class="clipboard-unlock clipboard-missing" data-view="missing" hidden
        aria-labelledby="clipboard-missing-title">
        <p class="clipboard-card-no">ROOM NOT FOUND</p>
        <h2 id="clipboard-missing-title">房间不存在</h2>
        <p>房间 <strong data-role="missing-room">—</strong> 不存在，是否用该名称创建一个无需密码的临时房间？</p>
        <p class="clipboard-missing-note">便捷模式 · 1 小时后自动销毁 · 知道链接的人可以编辑</p>
        <div class="clipboard-unlock-actions">
          <button class="clipboard-button primary" type="button" data-action="create-missing">创建临时房间</button>
          <button class="clipboard-button secondary" type="button" data-action="missing-back">暂不创建</button>
        </div>
      </section>

      <section class="clipboard-unlock" data-view="unlock" hidden aria-labelledby="clipboard-unlock-title">
        <p class="clipboard-card-no">PRIVATE ROOM</p>
        <h2 id="clipboard-unlock-title">输入房间密码</h2>
        <p>房间 <strong data-role="unlock-room">—</strong> 的内容已端到端加密，密码只在当前浏览器中用于派生解密密钥。</p>
        <form data-role="unlock-form">
          <label class="clipboard-field">
            <span>房间密码</span>
            <input type="password" autocomplete="current-password" data-role="unlock-password"
              aria-label="解锁密码" />
          </label>
          <div class="clipboard-unlock-actions">
            <button class="clipboard-button primary" type="submit">解锁并进入</button>
            <button class="clipboard-button secondary" type="button" data-action="unlock-back">返回</button>
          </div>
        </form>
      </section>

      <section class="clipboard-room" data-view="room" hidden aria-labelledby="clipboard-room-title">
        <header class="clipboard-room-bar">
          <div class="clipboard-room-name">
            <span class="clipboard-live-dot" aria-hidden="true"></span>
            <div>
              <span><b data-role="mode-badge">临时房间</b> · <span data-role="permission">只读</span></span>
              <strong id="clipboard-room-title" data-role="room-id">—</strong>
            </div>
          </div>
          <div class="clipboard-room-actions">
            <button class="clipboard-mini" type="button" data-action="share">复制房间链接</button>
            <button class="clipboard-mini" type="button" data-action="copy-room-password" hidden>复制密码</button>
            <button class="clipboard-mini" type="button" data-action="share-edit" hidden>复制可编辑链接</button>
            <button class="clipboard-mini" type="button" data-action="share-owner" hidden
              title="持有管理链接的人可以销毁房间">复制管理链接</button>
            <button class="clipboard-mini danger" type="button" data-action="destroy-room" hidden>销毁房间</button>
            <button class="clipboard-mini subtle" type="button" data-action="leave">退出</button>
          </div>
        </header>

        <div class="clipboard-workspace">
          <section class="clipboard-note" aria-labelledby="clipboard-note-title">
            <div class="clipboard-section-title">
              <div><span>TEXT NOTE</span><h2 id="clipboard-note-title">在线剪贴板</h2></div>
              <div class="clipboard-note-actions">
                <span data-role="save-state">已同步</span>
                <button type="button" data-action="copy-text">复制文字</button>
              </div>
            </div>
            <label class="clipboard-note-field">
              <span class="sr-only">共享文字</span>
              <textarea data-role="text" maxlength="20000"
                placeholder="在这里粘贴文字、链接或代码…"></textarea>
            </label>
            <div class="clipboard-note-foot">
              <span><b data-role="text-count">0</b> / 20,000</span>
              <span data-role="save-hint">输入后自动保存</span>
            </div>
          </section>

          <section class="clipboard-files" aria-labelledby="clipboard-files-title">
            <div class="clipboard-section-title">
              <div><span>FILE DROP</span><h2 id="clipboard-files-title">文件传输</h2></div>
              <span class="clipboard-limit" data-role="file-limit"></span>
            </div>
            <label class="clipboard-drop" data-role="drop">
              <input type="file" multiple data-role="files" />
              <span class="clipboard-drop-mark" aria-hidden="true">＋</span>
              <strong>拖放文件到这里</strong>
              <span data-role="drop-hint">或点此选择文件</span>
            </label>
            <div class="clipboard-upload" data-role="upload" hidden aria-live="polite">
              <div><span data-role="upload-name">正在处理文件</span><b data-role="upload-percent">0%</b></div>
              <progress max="100" value="0" data-role="upload-progress">0%</progress>
            </div>
            <ul class="clipboard-file-list" data-role="file-list" aria-label="房间文件"></ul>
            <p class="clipboard-empty" data-role="file-empty">还没有文件。它们只适合临时中转，请保留本地副本。</p>
          </section>
        </div>

        <footer class="clipboard-room-foot">
          <span data-role="expires">—</span>
          <span data-role="privacy-note">—</span>
        </footer>
      </section>

      <div class="clipboard-status" data-role="status" role="status" aria-live="polite"></div>
    </section>
  `;
}
export function mountClipboard(root, options = {}) {
  if (!(root instanceof Element)) throw new TypeError("mountClipboard 需要一个 DOM 容器");
  root.innerHTML = template();

  const apiBase = String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const shortOrigin = String(options.shortOrigin || DEFAULT_SHORT_ORIGIN).replace(/\/+$/, "");
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const pollInterval = Math.max(1000, options.pollInterval || 2500);
  const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const entry = root.querySelector('[data-view="entry"]');
  const missingView = root.querySelector('[data-view="missing"]');
  const unlockView = root.querySelector('[data-view="unlock"]');
  const roomView = root.querySelector('[data-view="room"]');
  const roomInput = root.querySelector('[data-role="room-input"]');
  const textArea = root.querySelector('[data-role="text"]');
  const fileInput = root.querySelector('[data-role="files"]');
  const drop = root.querySelector('[data-role="drop"]');
  const status = root.querySelector('[data-role="status"]');
  const fileList = root.querySelector('[data-role="file-list"]');
  const uploadBox = root.querySelector('[data-role="upload"]');
  const roomNameInput = root.querySelector('[data-role="room-name"]');
  const passwordInput = root.querySelector('[data-role="password"]');
  const ttlPreset = root.querySelector('[data-role="ttl-preset"]');
  const ttlCustom = root.querySelector('[data-role="ttl-custom"]');

  const state = {
    roomId: "",
    mode: "private",
    legacy: false,
    collaborative: false,
    publicWritable: false,
    key: null,
    encodedKey: "",
    roomPassword: "",
    writeToken: "",
    ownerToken: "",
    expiresAt: 0,
    revision: 0,
    files: [],
    missingRoomId: "",
    pendingRoom: null,
    pendingReference: null,
    pollTimer: 0,
    expiryTimer: 0,
    saveTimer: 0,
    statusTimer: 0,
    destroyed: false,
    saving: false,
    dirty: false,
    loading: false,
    canWrite: false
  };

  roomNameInput.value = randomRoomId(8);
  passwordInput.value = generateRoomPassword();
  root.querySelector('[data-role="file-limit"]').textContent =
    `单个不超过 ${bytesLabel(maxFileBytes)}`;

  function announce(message, tone = "") {
    clearTimeout(state.statusTimer);
    status.textContent = message;
    status.dataset.tone = tone;
    status.classList.add("show");
    state.statusTimer = setTimeout(() => status.classList.remove("show"), 3200);
  }

  function replaceGeneratedPassword({ focus = true, notify = true } = {}) {
    passwordInput.value = generateRoomPassword();
    passwordInput.type = "text";
    root.querySelector('[data-action="toggle-password"]').textContent = "隐藏";
    if (focus) {
      passwordInput.focus();
      passwordInput.select();
    }
    if (notify) announce("已生成新的房间密码", "success");
  }

  function endpoint(path = "") {
    return `${apiBase}${path}`;
  }

  function authToken(kind = "write") {
    if (kind === "owner") return state.ownerToken;
    return state.writeToken || state.ownerToken;
  }

  async function request(path, init = {}, raw = false) {
    const { auth = init.method && init.method !== "GET" ? "write" : "none", ...fetchInit } = init;
    const headers = new Headers(fetchInit.headers || {});
    const token = auth === "none" ? "" : authToken(auth);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (fetchInit.body && !(fetchInit.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetcher(endpoint(path), { ...fetchInit, headers });
    if (!response.ok) {
      let body = null;
      let detail = "";
      try {
        body = await response.json();
        detail = body.message || body.error?.message ||
          (typeof body.error === "string" ? body.error : "");
      } catch {
        detail = await response.text().catch(() => "");
      }
      throw new ApiError(
        detail || `请求失败（${response.status}）`,
        response.status,
        body?.error?.code || body?.code || "",
        body?.error?.details || body?.details || null
      );
    }
    if (raw) return response;
    if (response.status === 204) return {};
    return responsePayload(await response.json());
  }

  function isNamedRoom() {
    return Boolean(state.roomId) && !isLegacyRoomId(state.roomId);
  }

  function shareUrl(editable = false, manageable = false) {
    let url;
    if (isNamedRoom()) {
      url = new URL(shortOrigin);
      url.pathname = `/${encodeURIComponent(state.roomId)}`;
    } else {
      url = new URL(globalThis.location.href);
      url.pathname = `/clipboard/r/${encodeURIComponent(state.roomId)}`;
    }
    url.search = "";
    const params = new URLSearchParams();
    if (state.legacy && state.encodedKey) params.set("key", state.encodedKey);
    if (editable && state.legacy && state.writeToken) params.set("write", state.writeToken);
    if (manageable && state.ownerToken) params.set("owner", state.ownerToken);
    url.hash = params.toString();
    return url.toString();
  }

  function localRoomUrl() {
    const url = new URL(globalThis.location.href);
    const onShortHost = url.hostname.toLowerCase() === shortHostname(shortOrigin);
    url.pathname = onShortHost && isNamedRoom()
      ? `/${encodeURIComponent(state.roomId)}`
      : `/clipboard/r/${encodeURIComponent(state.roomId)}`;
    url.search = "";
    url.hash = state.legacy && state.encodedKey
      ? hashForKey(state.encodedKey).slice(1)
      : "";
    return url;
  }

  function navigateToRoom() {
    const url = localRoomUrl();
    if (typeof options.onNavigate === "function") options.onNavigate(url.toString(), state.roomId);
    else globalThis.history?.replaceState({ clipboardRoom: state.roomId }, "", url);
  }

  function navigateToEntry() {
    const url = new URL(globalThis.location.href);
    url.pathname = url.hostname.toLowerCase() === shortHostname(shortOrigin)
      ? "/"
      : "/clipboard/";
    url.search = "";
    url.hash = "";
    if (typeof options.onNavigate === "function") options.onNavigate(url.toString(), "");
    else globalThis.history?.replaceState({}, "", url);
  }

  function setViews(view) {
    entry.hidden = view !== "entry";
    missingView.hidden = view !== "missing";
    unlockView.hidden = view !== "unlock";
    roomView.hidden = view !== "room";
  }

  function showMissingRoom(roomId) {
    state.missingRoomId = roomId;
    root.querySelector('[data-role="missing-room"]').textContent = roomId;
    setViews("missing");
  }

  function prepareMissingRoomDefaults(roomId) {
    roomNameInput.value = roomId;
    root.querySelector('input[name="room-mode"][value="convenience"]').checked = true;
    root.querySelector('[data-role="collaborative"]').checked = true;
    ttlPreset.value = "3600";
    root.querySelector('[data-role="custom-ttl-field"]').hidden = true;
    updateModeUI();
  }

  function updateModeUI() {
    const mode = root.querySelector('input[name="room-mode"]:checked')?.value || "private";
    if (mode === "private" && !passwordInput.value) {
      replaceGeneratedPassword({ focus: false, notify: false });
    }
    root.querySelectorAll(".clipboard-mode").forEach((label) => {
      label.classList.toggle("selected", label.querySelector("input").checked);
    });
    root.querySelector('[data-role="password-field"]').hidden = mode !== "private";
    root.querySelector('[data-role="mode-help"]').textContent = mode === "private"
      ? "隐私模式使用独立密码端到端加密，分享短链接时请另行告知密码。"
      : "便捷模式像普通网络剪贴板一样即开即用，内容对 Worker 可见，请勿存放敏感信息。";
    root.querySelector('[data-role="collaborative-title"]').textContent = mode === "private"
      ? "知道密码的人可以编辑"
      : "知道短链接的人可以编辑";
    root.querySelector('[data-action="create"]').textContent = mode === "private"
      ? "创建隐私房间"
      : "创建便捷房间";
  }

  function setWritable() {
    textArea.readOnly = !state.canWrite;
    fileInput.disabled = !state.canWrite;
    drop.classList.toggle("disabled", !state.canWrite);
    const permission = state.ownerToken
      ? "房主"
      : state.canWrite && state.publicWritable
        ? "公开协作"
        : state.canWrite
          ? "密码协作"
          : "只读";
    root.querySelector('[data-role="permission"]').textContent = permission;
    root.querySelector('[data-role="mode-badge"]').textContent = state.mode === "private"
      ? "隐私房间"
      : "便捷房间";
    root.querySelector('[data-action="copy-room-password"]').hidden =
      !(state.mode === "private" && state.roomPassword);
    root.querySelector('[data-action="share-edit"]').hidden = !(state.legacy && state.canWrite);
    root.querySelector('[data-action="share-owner"]').hidden = !state.ownerToken;
    root.querySelector('[data-action="destroy-room"]').hidden = !state.ownerToken;
    root.querySelector('[data-role="save-state"]').textContent = state.canWrite ? "已同步" : "只读房间";
    root.querySelector('[data-role="save-hint"]').textContent = state.mode === "private"
      ? "输入后在本机加密保存"
      : "输入后自动保存到临时房间";
    root.querySelector('[data-role="drop-hint"]').textContent = state.mode === "private"
      ? "或点此选择文件；上传前会先在本机加密"
      : "或点此选择文件；便捷模式会直接上传";
    root.querySelector('[data-role="privacy-note"]').textContent = state.mode === "private"
      ? "密码只在浏览器中使用；服务器只保存密文"
      : "便捷模式不是端到端加密，请勿传输敏感内容";
  }

  function updateExpiry() {
    const target = normalizeTime(state.expiresAt);
    if (!target) {
      root.querySelector('[data-role="expires"]').textContent = "临时存储";
      return;
    }
    const exact = new Date(target).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    root.querySelector('[data-role="expires"]').textContent =
      `自动销毁 · ${expiryLabel(target)}（${exact}）`;
  }

  async function copy(value, successMessage) {
    try {
      await navigator.clipboard.writeText(value);
      announce(successMessage, "success");
    } catch {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.append(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
      announce(successMessage, "success");
    }
  }

  async function metadataFor(item) {
    if (state.mode !== "private") {
      return {
        name: item.name || "共享文件",
        type: item.type || "application/octet-stream",
        size: item.size || 0
      };
    }
    const encrypted = payloadEnvelope(item.meta || item.metadata);
    if (!encrypted) {
      return {
        name: item.name || "加密文件",
        type: item.type || "application/octet-stream",
        size: item.originalSize || item.size || 0
      };
    }
    return decryptJson(encrypted, state.key);
  }

  function makeFileItem(item, metadata) {
    const li = document.createElement("li");
    li.className = "clipboard-file";
    const main = document.createElement("div");
    main.className = "clipboard-file-main";
    const icon = document.createElement("span");
    icon.className = "clipboard-file-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "↧";
    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = metadata.name || "未命名文件";
    const info = document.createElement("span");
    info.textContent = `${bytesLabel(metadata.size || item.size)} · 随房间销毁`;
    details.append(name, info);
    main.append(icon, details);

    const actions = document.createElement("div");
    actions.className = "clipboard-file-actions";
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "下载";
    download.addEventListener("click", () => downloadItem(item, metadata, download));
    actions.append(download);
    if (state.canWrite) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "删除";
      remove.addEventListener("click", () => removeItem(item, remove));
      actions.append(remove);
    }
    li.append(main, actions);
    return li;
  }

  async function renderFiles(items) {
    fileList.replaceChildren();
    root.querySelector('[data-role="file-empty"]').hidden = items.length > 0;
    for (const item of items) {
      try {
        fileList.append(makeFileItem(item, await metadataFor(item)));
      } catch {
        fileList.append(makeFileItem(item, {
          name: state.mode === "private" ? "无法解密的文件" : "共享文件",
          type: "application/octet-stream",
          size: item.size || 0
        }));
      }
    }
  }

  function applyRoomMetadata(room) {
    state.mode = room.mode || "private";
    state.legacy = Boolean(room.legacy) || (!room.crypto && Boolean(state.encodedKey));
    state.collaborative = Boolean(room.collaborative);
    state.publicWritable = Boolean(room.publicWritable);
    state.expiresAt = room.expiresAt || state.expiresAt;
    state.canWrite = state.publicWritable || Boolean(state.writeToken || state.ownerToken);
    root.querySelector('[data-role="room-id"]').textContent = state.roomId;
    setWritable();
    updateExpiry();
  }

  async function applyRoomContent(room, { initial = false } = {}) {
    applyRoomMetadata(room);
    const remoteRevision = Number(room.revision) || 0;
    if ((initial || remoteRevision > state.revision) && !state.dirty && !state.saving) {
      let remoteText = "";
      if (state.mode === "private") {
        const envelope = payloadEnvelope(room.payload ?? room.text);
        remoteText = envelope ? await decryptText(envelope, state.key) : "";
      } else {
        remoteText = room.payload == null ? "" : String(room.payload);
      }
      if (textArea.value !== remoteText) textArea.value = remoteText;
      root.querySelector('[data-role="text-count"]').textContent = textArea.value.length;
    }
    state.revision = Math.max(state.revision, remoteRevision);
    const nextFiles = Array.isArray(room.files) ? room.files : [];
    const signature = JSON.stringify(nextFiles.map((item) => [
      item.id, item.name, item.type, item.size, item.createdAt, item.meta || item.metadata
    ]));
    const oldSignature = JSON.stringify(state.files.map((item) => [
      item.id, item.name, item.type, item.size, item.createdAt, item.meta || item.metadata
    ]));
    if (initial || signature !== oldSignature) {
      state.files = nextFiles;
      await renderFiles(nextFiles);
    }
  }
  async function loadRoom({ quiet = false, initial = false } = {}) {
    if (!state.roomId || state.loading || state.destroyed || (!state.key && state.mode === "private")) return;
    state.loading = true;
    try {
      const room = await request(`/rooms/${encodeURIComponent(state.roomId)}`, {
        method: "GET",
        auth: "none"
      });
      await applyRoomContent(room, { initial });
    } catch (error) {
      if (error instanceof ApiError && [404, 410].includes(error.status)) {
        clearInterval(state.pollTimer);
        clearInterval(state.expiryTimer);
        setViews("entry");
        navigateToEntry();
        announce("房间已销毁或已经到期", "error");
      } else if (!quiet) {
        announce(error.message, "error");
      }
    } finally {
      state.loading = false;
    }
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    clearInterval(state.expiryTimer);
    state.pollTimer = setInterval(() => loadRoom({ quiet: true }), pollInterval);
    state.expiryTimer = setInterval(updateExpiry, 30000);
  }

  function ownerStorageKey(roomId) {
    return `clipboard.ownerToken.${roomId}`;
  }

  function legacyStorageKey(roomId) {
    return `clipboard.writeToken.${roomId}`;
  }

  async function finishEntering(room, reference = {}) {
    state.roomId = normalizeRoomId(room.roomId || reference.roomId);
    state.encodedKey = reference.encodedKey || state.encodedKey;
    state.ownerToken = reference.ownerToken || state.ownerToken || safeStorageGet(ownerStorageKey(state.roomId));
    state.writeToken = reference.writeToken || state.writeToken;
    state.mode = room.mode || "private";
    state.legacy = Boolean(room.legacy) || (!room.crypto && Boolean(state.encodedKey));
    if (reference.password) state.roomPassword = reference.password;

    if (reference.key) {
      state.key = reference.key;
    } else if (state.mode === "private" && state.legacy) {
      if (!state.encodedKey) throw new Error("分享链接缺少加密密钥");
      state.key = await importShareKey(state.encodedKey);
      state.writeToken = state.writeToken || safeStorageGet(legacyStorageKey(state.roomId));
    } else if (state.mode === "private") {
      if (!reference.password) {
        state.pendingRoom = room;
        state.pendingReference = reference;
        root.querySelector('[data-role="unlock-room"]').textContent = state.roomId;
        root.querySelector('[data-role="unlock-password"]').value = "";
        setViews("unlock");
        return false;
      }
      const secrets = await unlockPasswordRoom(reference.password, room.crypto);
      state.key = secrets.key;
      if (room.collaborative) state.writeToken = secrets.writeToken;
    } else {
      state.key = null;
    }

    if (state.ownerToken) {
      safeStorageSet(ownerStorageKey(state.roomId), state.ownerToken);
      if (!state.writeToken) state.writeToken = state.ownerToken;
    }
    if (state.legacy && state.writeToken) {
      safeStorageSet(legacyStorageKey(state.roomId), state.writeToken);
    }

    state.pendingRoom = null;
    state.pendingReference = null;
    applyRoomMetadata(room);
    setViews("room");
    navigateToRoom();
    await applyRoomContent(room, { initial: true });
    startPolling();
    return true;
  }

  async function enterRoom(reference) {
    const roomId = normalizeRoomId(reference.roomId);
    if (!roomId) throw new Error("房间名称或链接格式不正确");
    state.roomId = roomId;
    state.encodedKey = reference.encodedKey || "";
    state.ownerToken = reference.ownerToken || safeStorageGet(ownerStorageKey(roomId));
    state.writeToken = reference.writeToken || "";
    let room;
    try {
      room = await request(`/rooms/${encodeURIComponent(roomId)}`, {
        method: "GET",
        auth: "none"
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 404 &&
        isValidCustomRoomId(roomId)
      ) {
        showMissingRoom(roomId);
        return false;
      }
      throw error;
    }
    return finishEntering(room, reference);
  }

  async function createRoom() {
    const button = root.querySelector('[data-action="create"]');
    button.disabled = true;
    button.textContent = "正在创建…";
    try {
      const roomId = normalizeCustomRoomId(roomNameInput.value);
      if (!isValidCustomRoomId(roomId)) {
        throw new Error("房间名称需要 3～16 位，并以字母、数字或中文开头和结尾");
      }
      const mode = root.querySelector('input[name="room-mode"]:checked')?.value || "private";
      const collaborative = root.querySelector('[data-role="collaborative"]').checked;
      const keepSeconds = ttlSeconds(ttlPreset.value, ttlCustom.value);
      let secrets = null;
      let crypto = null;
      let writeTokenHash = null;
      let roomPassword = "";
      if (mode === "private") {
        const password = passwordInput.value;
        if (Array.from(password.normalize("NFKC")).length < 8) {
          throw new Error("隐私房间密码至少需要 8 位");
        }
        roomPassword = password;
        secrets = await createPasswordRoomSecrets(password);
        crypto = secrets.crypto;
        if (collaborative) writeTokenHash = await hashRoomToken(secrets.writeToken);
      }

      const created = await request("/rooms", {
        method: "POST",
        auth: "none",
        body: JSON.stringify({
          roomId,
          mode,
          collaborative,
          ttlSeconds: keepSeconds,
          crypto,
          ...(writeTokenHash ? { writeTokenHash } : {})
        })
      });
      const ownerToken = created.ownerToken || created.writeToken;
      if (!created.roomId || !ownerToken) throw new Error("Worker 返回的房间信息不完整");
      state.expiresAt = created.expiresAt;
      state.revision = Number(created.revision) || 0;
      state.ownerToken = ownerToken;
      state.writeToken = mode === "private" && collaborative
        ? secrets.writeToken
        : ownerToken;
      state.roomPassword = roomPassword;
      state.key = secrets?.key || null;
      state.encodedKey = "";
      await finishEntering(created, {
        roomId: created.roomId,
        key: secrets?.key || null,
        writeToken: state.writeToken,
        ownerToken
      });
      passwordInput.value = "";
      announce(
        mode === "private"
          ? "隐私房间已创建；分享链接时请另行告知密码"
          : "便捷房间已创建",
        "success"
      );
    } catch (error) {
      announce(error.message, "error");
    } finally {
      button.disabled = false;
      updateModeUI();
    }
  }
  async function saveText() {
    if (!state.canWrite || (state.mode === "private" && !state.key) || state.destroyed) return;
    clearTimeout(state.saveTimer);
    state.saving = true;
    state.dirty = false;
    root.querySelector('[data-role="save-state"]').textContent = state.mode === "private"
      ? "正在加密保存…"
      : "正在保存…";
    try {
      const payload = state.mode === "private"
        ? await encryptText(textArea.value, state.key)
        : textArea.value;
      const saved = await request(`/rooms/${encodeURIComponent(state.roomId)}/text`, {
        method: "PUT",
        body: JSON.stringify({ payload, revision: state.revision })
      });
      state.revision = Number(saved.revision) || state.revision + 1;
      state.expiresAt = saved.expiresAt || state.expiresAt;
      root.querySelector('[data-role="save-state"]').textContent = "已同步";
    } catch (error) {
      state.dirty = true;
      if (error instanceof ApiError && error.status === 409 &&
          Number.isSafeInteger(error.details?.revision)) {
        state.revision = error.details.revision;
        root.querySelector('[data-role="save-state"]').textContent = "远端刚更新，正在重试…";
        announce("另一台设备刚有更新，正在重新保存本机内容");
      } else {
        root.querySelector('[data-role="save-state"]').textContent = "保存失败";
        announce(error.message, "error");
      }
    } finally {
      state.saving = false;
      if (state.dirty) state.saveTimer = setTimeout(saveText, 1800);
    }
  }

  function scheduleSave() {
    if (!state.canWrite) return;
    state.dirty = true;
    clearTimeout(state.saveTimer);
    root.querySelector('[data-role="save-state"]').textContent = "等待保存…";
    state.saveTimer = setTimeout(saveText, 650);
  }

  function uploadWithProgress(path, body, headers, onProgress) {
    if (options.upload) {
      return options.upload(endpoint(path), body, authToken(), onProgress, headers);
    }
    if (typeof XMLHttpRequest === "undefined") {
      onProgress(70);
      return request(path, { method: "POST", headers, body }).then((value) => {
        onProgress(100);
        return value;
      });
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", endpoint(path));
      const token = authToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(25 + Math.round(event.loaded / event.total * 75));
      };
      xhr.onerror = () => reject(new Error("文件上传失败，请检查网络"));
      xhr.onload = () => {
        let responseBody = {};
        try {
          responseBody = xhr.responseText ? responsePayload(JSON.parse(xhr.responseText)) : {};
        } catch {
          responseBody = {};
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(responseBody.message || responseBody.error?.message ||
            (typeof responseBody.error === "string" ? responseBody.error : `文件上传失败（${xhr.status}）`)));
        } else {
          onProgress(100);
          resolve(responseBody);
        }
      };
      xhr.send(body);
    });
  }

  function setUpload(fileName, progress) {
    uploadBox.hidden = false;
    root.querySelector('[data-role="upload-name"]').textContent = fileName;
    root.querySelector('[data-role="upload-percent"]').textContent = `${progress}%`;
    const bar = root.querySelector('[data-role="upload-progress"]');
    bar.value = progress;
    bar.textContent = `${progress}%`;
  }

  async function addFiles(fileSource) {
    if (!state.canWrite) return announce("当前链接为只读模式", "error");
    const files = Array.from(fileSource || []);
    for (const file of files) {
      const overhead = state.mode === "private" ? 29 : 0;
      if (file.size + overhead > maxFileBytes) {
        announce(`${file.name} 超过 ${bytesLabel(maxFileBytes)}`, "error");
        continue;
      }
      try {
        let uploadBody = file;
        let headers;
        if (state.mode === "private") {
          setUpload(`正在加密 · ${file.name}`, 4);
          const [encrypted, meta] = await Promise.all([
            encryptFile(file, state.key),
            encryptJson({
              name: file.name || "未命名文件",
              type: file.type || "application/octet-stream",
              size: file.size,
              lastModified: file.lastModified || 0
            }, state.key)
          ]);
          uploadBody = encrypted;
          headers = {
            "Content-Type": "application/octet-stream",
            "X-File-Name": "encrypted.bin",
            "X-File-Type": "application/octet-stream",
            "X-File-Meta": JSON.stringify(meta)
          };
        } else {
          setUpload(`正在准备 · ${file.name}`, 8);
          headers = {
            "Content-Type": file.type || "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name || "shared-file.bin"),
            "X-File-Type": file.type || "application/octet-stream"
          };
        }
        setUpload(`正在上传 · ${file.name}`, 25);
        await uploadWithProgress(
          `/rooms/${encodeURIComponent(state.roomId)}/files`,
          uploadBody,
          headers,
          (progress) => setUpload(`正在上传 · ${file.name}`, progress)
        );
        announce(`${file.name} 已上传`, "success");
        await loadRoom();
      } catch (error) {
        announce(error.message, "error");
      }
    }
    fileInput.value = "";
    setTimeout(() => { uploadBox.hidden = true; }, 700);
  }

  async function downloadItem(item, metadata, button) {
    button.disabled = true;
    button.textContent = state.mode === "private" ? "解密中…" : "下载中…";
    try {
      const response = await request(
        `/rooms/${encodeURIComponent(state.roomId)}/files/${encodeURIComponent(item.id)}`,
        { method: "GET", auth: "none" },
        true
      );
      const received = await response.blob();
      const output = state.mode === "private"
        ? await decryptFile(received, state.key, metadata.type)
        : received;
      const url = URL.createObjectURL(output);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = metadata.name || "下载文件";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      announce(state.mode === "private" ? "文件已在本机解密" : "文件已下载", "success");
    } catch (error) {
      announce(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "下载";
    }
  }

  async function removeItem(item, button) {
    button.disabled = true;
    try {
      await request(`/rooms/${encodeURIComponent(state.roomId)}/files/${encodeURIComponent(item.id)}`, {
        method: "DELETE"
      });
      state.files = state.files.filter((candidate) => candidate.id !== item.id);
      await renderFiles(state.files);
      announce("文件已从房间删除", "success");
    } catch (error) {
      announce(error.message, "error");
      button.disabled = false;
    }
  }

  function clearTimers() {
    clearInterval(state.pollTimer);
    clearInterval(state.expiryTimer);
    clearTimeout(state.saveTimer);
  }

  function resetRoomState() {
    clearTimers();
    state.roomId = "";
    state.mode = "private";
    state.legacy = false;
    state.collaborative = false;
    state.publicWritable = false;
    state.key = null;
    state.encodedKey = "";
    state.roomPassword = "";
    state.writeToken = "";
    state.ownerToken = "";
    state.expiresAt = 0;
    state.files = [];
    state.missingRoomId = "";
    state.revision = 0;
    state.pendingRoom = null;
    state.pendingReference = null;
    state.canWrite = false;
    state.dirty = false;
    state.saving = false;
    textArea.value = "";
    root.querySelector('[data-role="text-count"]').textContent = "0";
    fileList.replaceChildren();
  }

  function leaveRoom() {
    resetRoomState();
    setViews("entry");
    navigateToEntry();
  }

  async function destroyRoom() {
    if (!state.ownerToken) return announce("只有持有房主管理权限的终端可以销毁房间", "error");
    if (!globalThis.confirm(`确定立即销毁房间“${state.roomId}”吗？文字和文件都会删除。`)) return;
    if (!globalThis.confirm("这是最后确认：销毁后无法恢复，也不会影响他人已经下载的副本。")) return;
    const roomId = state.roomId;
    try {
      await request(`/rooms/${encodeURIComponent(roomId)}`, {
        method: "DELETE",
        auth: "owner"
      });
      safeStorageSet(ownerStorageKey(roomId), "");
      safeStorageSet(legacyStorageKey(roomId), "");
      resetRoomState();
      setViews("entry");
      navigateToEntry();
      announce("房间及其云端文件已彻底销毁", "success");
    } catch (error) {
      announce(error.message, "error");
    }
  }
  root.querySelectorAll('input[name="room-mode"]').forEach((input) => {
    input.addEventListener("change", updateModeUI);
  });
  root.querySelector('[data-action="random-name"]').addEventListener("click", () => {
    roomNameInput.value = randomRoomId(8);
    roomNameInput.focus();
  });
  root.querySelector('[data-action="generate-password"]').addEventListener("click", () => {
    replaceGeneratedPassword();
  });
  root.querySelector('[data-action="copy-password"]').addEventListener("click", () => {
    if (!passwordInput.value) replaceGeneratedPassword({ focus: false, notify: false });
    copy(passwordInput.value, "房间密码已复制");
  });
  root.querySelector('[data-action="toggle-password"]').addEventListener("click", (event) => {
    const visible = passwordInput.type === "text";
    passwordInput.type = visible ? "password" : "text";
    event.currentTarget.textContent = visible ? "显示" : "隐藏";
  });
  roomNameInput.addEventListener("blur", () => {
    const normalized = normalizeCustomRoomId(roomNameInput.value);
    if (normalized) roomNameInput.value = normalized;
  });
  ttlPreset.addEventListener("change", () => {
    root.querySelector('[data-role="custom-ttl-field"]').hidden = ttlPreset.value !== "custom";
    if (ttlPreset.value === "custom") ttlCustom.focus();
  });
  root.querySelector('[data-action="create"]').addEventListener("click", createRoom);
  root.querySelector('[data-action="create-missing"]').addEventListener("click", async () => {
    const roomId = state.missingRoomId;
    if (!roomId) return;
    prepareMissingRoomDefaults(roomId);
    state.missingRoomId = "";
    setViews("entry");
    await createRoom();
  });
  root.querySelector('[data-action="missing-back"]').addEventListener("click", () => {
    resetRoomState();
    setViews("entry");
    navigateToEntry();
  });
  root.querySelector('[data-role="join-form"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await enterRoom(roomReference(roomInput.value, shortOrigin));
    } catch (error) {
      announce(error.message, "error");
    }
  });
  root.querySelector('[data-role="unlock-form"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "正在解锁…";
    try {
      const room = state.pendingRoom;
      const reference = state.pendingReference || {};
      if (!room) throw new Error("待解锁房间已经失效");
      await finishEntering(room, {
        ...reference,
        password: root.querySelector('[data-role="unlock-password"]').value
      });
      announce("隐私房间已解锁", "success");
    } catch (error) {
      announce(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "解锁并进入";
    }
  });
  root.querySelector('[data-action="unlock-back"]').addEventListener("click", () => {
    resetRoomState();
    setViews("entry");
    navigateToEntry();
  });
  root.querySelector('[data-action="share"]').addEventListener("click", () => {
    copy(
      shareUrl(false),
      state.mode === "private" && !state.legacy
        ? "短链接已复制；请通过其他渠道告知房间密码"
        : "房间链接已复制"
    );
  });
  root.querySelector('[data-action="copy-room-password"]').addEventListener("click", () => {
    if (!state.roomPassword) return announce("当前标签页没有保存房间密码", "error");
    copy(state.roomPassword, "房间密码已复制，请通过其他渠道发送");
  });
  root.querySelector('[data-action="share-edit"]').addEventListener("click", () => {
    copy(shareUrl(true), "可编辑链接已复制，请只发给信任的人");
  });
  root.querySelector('[data-action="share-owner"]').addEventListener("click", () => {
    copy(shareUrl(false, true), "管理链接已复制；持有者可以销毁房间，请只发给信任的人");
  });
  root.querySelector('[data-action="copy-text"]').addEventListener("click", () => {
    copy(textArea.value, "文字已复制");
  });
  root.querySelector('[data-action="destroy-room"]').addEventListener("click", destroyRoom);
  root.querySelector('[data-action="leave"]').addEventListener("click", leaveRoom);
  textArea.addEventListener("input", () => {
    root.querySelector('[data-role="text-count"]').textContent = textArea.value.length;
    scheduleSave();
  });
  fileInput.addEventListener("change", () => addFiles(fileInput.files));
  ["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    if (state.canWrite) drop.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove("dragging");
  }));
  drop.addEventListener("drop", (event) => addFiles(event.dataTransfer?.files));
  roomView.addEventListener("paste", (event) => {
    const pastedFiles = Array.from(event.clipboardData?.files || []);
    if (pastedFiles.length) {
      event.preventDefault();
      addFiles(pastedFiles);
    }
  });

  updateModeUI();
  const initialRoomId = options.roomId || roomFromPath(
    globalThis.location?.pathname,
    globalThis.location?.hostname,
    shortOrigin
  );
  const initialReference = {
    roomId: initialRoomId,
    encodedKey: options.encodedKey || keyFromHash(),
    writeToken: options.writeToken || tokenFromHash(globalThis.location?.hash, "write"),
    ownerToken: options.ownerToken || tokenFromHash(globalThis.location?.hash, "owner")
  };
  if (initialRoomId) {
    enterRoom(initialReference).catch((error) => {
      setViews("entry");
      announce(error.message, "error");
    });
  }

  return {
    get roomId() { return state.roomId; },
    refresh: () => loadRoom(),
    destroy() {
      state.destroyed = true;
      clearTimers();
      clearTimeout(state.statusTimer);
      root.replaceChildren();
    }
  };
}

export const clipboardInternals = {
  bytesLabel,
  expiryLabel,
  roomFromPath,
  roomReference,
  ttlSeconds,
  validRoomId
};
