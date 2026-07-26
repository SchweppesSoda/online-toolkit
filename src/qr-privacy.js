// Scanner: qr-scanner 1.4.2 by Nimiq and contributors.
// Source: https://github.com/nimiq/qr-scanner — MIT. See THIRD_PARTY_NOTICES.md.
import QrScanner from "qr-scanner";
// Generator: node-qrcode/qrcode 1.5.4 by Ryan Day and contributors.
// Source: https://github.com/soldair/node-qrcode — MIT. See THIRD_PARTY_NOTICES.md.
import QRCode from "qrcode";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TRACKING_KEYS = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "yclid", "si", "spm", "ref_src"]);
const SHORTENER_HOSTS = new Set(["bit.ly", "t.co", "tinyurl.com", "goo.gl", "is.gd", "ow.ly", "buff.ly", "cutt.ly", "rebrand.ly", "shorturl.at", "tiny.one", "rb.gy", "s.id"]);
const SEVERITY_RANK = { safe: 0, notice: 1, warning: 2, danger: 3 };
const SEVERITY_LABEL = { safe: "未见明显技术风险", notice: "注意内容类型", warning: "建议谨慎", danger: "高风险" };

function isTrackingKey(key) {
  const normalized = key.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_KEYS.has(normalized);
}

export function stripTrackingParameters(input) {
  const url = new URL(input);
  const removed = [];
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingKey(key)) {
      removed.push(key);
      url.searchParams.delete(key);
    }
  }
  return { url: url.toString(), removed };
}

function isIpHostname(hostname) {
  const value = hostname.replace(/^\[|\]$/g, "");
  const parts = value.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return true;
  return value.includes(":") && /^[0-9a-f:]+$/i.test(value);
}

function raise(current, candidate) {
  return SEVERITY_RANK[candidate] > SEVERITY_RANK[current] ? candidate : current;
}

function urlLikeWithoutProtocol(value) {
  return /^(?:www\.)?[\p{L}\d](?:[\p{L}\d.-]*[\p{L}\d])?\.[a-z\p{L}]{2,}(?:[/:?#]|$)/iu.test(value);
}

export function analyzeQrContent(input) {
  const raw = String(input ?? "").trim();
  const result = {
    raw,
    kind: "文字",
    summary: "普通文字内容",
    severity: "safe",
    severityLabel: SEVERITY_LABEL.safe,
    details: [],
    openUrl: null,
    cleanUrl: null,
    removedTracking: []
  };
  const add = (label, value, level = "neutral") => result.details.push({ label, value, level });
  const warn = (severity, label, message) => {
    result.severity = raise(result.severity, severity);
    add(label, message, severity);
  };

  if (!raw) {
    result.kind = "空内容";
    result.summary = "二维码没有可显示的文字";
    result.severity = "warning";
    warn("warning", "提醒", "空二维码可能无法按预期使用。");
    result.severityLabel = SEVERITY_LABEL[result.severity];
    return result;
  }
  add("字符数", `${raw.length}`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) warn("warning", "控制字符", "内容含有不可见控制字符，复制或粘贴时需谨慎。");

  const lower = raw.toLowerCase();
  if (/^(javascript|vbscript|data|file):/.test(lower)) {
    const scheme = lower.slice(0, lower.indexOf(":"));
    result.kind = "危险协议";
    result.summary = `不要执行 ${scheme}: 内容`;
    warn("danger", "协议", `${scheme}: 可触发脚本、本地文件或嵌入内容，本站不会提供打开按钮。`);
    result.severityLabel = SEVERITY_LABEL[result.severity];
    return result;
  }
  if (/^otpauth:/.test(lower)) {
    result.kind = "动态验证码密钥";
    result.summary = "可能包含账号的二次验证密钥";
    warn("danger", "敏感内容", "任何拿到此二维码的人都可能复制验证码密钥，请勿分享截图。");
    result.severityLabel = SEVERITY_LABEL[result.severity];
    return result;
  }
  if (/^wifi:/.test(lower)) {
    result.kind = "Wi-Fi 配置";
    result.summary = "包含可导入的无线网络信息";
    warn("warning", "密码提醒", "Wi-Fi 二维码通常直接包含网络密码，只应分享给可信的人。");
    result.severityLabel = SEVERITY_LABEL[result.severity];
    return result;
  }
  if (/^begin:vcard/i.test(raw)) {
    result.kind = "联系人名片";
    result.summary = "联系人资料（vCard）";
    warn("notice", "隐私提醒", "名片可能包含姓名、电话、邮箱和地址，请先核对原始内容。");
    result.severityLabel = SEVERITY_LABEL[result.severity];
    return result;
  }
  if (/^(mailto|tel|sms):/i.test(raw)) {
    const scheme = raw.slice(0, raw.indexOf(":")).toLowerCase();
    const labels = { mailto: "电子邮件", tel: "电话号码", sms: "短信" };
    result.kind = labels[scheme];
    result.summary = `${labels[scheme]}操作内容`;
    warn("notice", "操作提醒", "系统应用可能据此发起联系；本站只显示内容，不会自动执行。");
    result.severityLabel = SEVERITY_LABEL[result.severity];
    return result;
  }

  let parsed;
  try { parsed = new URL(raw); }
  catch {
    if (urlLikeWithoutProtocol(raw)) {
      result.kind = "疑似网址";
      result.summary = "看起来像网址，但没有写协议";
      warn("warning", "缺少协议", "不要让其他应用替你猜测打开方式；请先确认完整网址。");
    }
    result.severityLabel = SEVERITY_LABEL[result.severity];
    return result;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    result.kind = "自定义协议";
    result.summary = `${parsed.protocol} 内容`;
    warn("warning", "协议", "这不是普通网页链接，可能唤起其他应用；本站不会提供打开按钮。");
    result.severityLabel = SEVERITY_LABEL[result.severity];
    return result;
  }

  result.kind = "网页链接";
  result.summary = parsed.protocol === "https:" ? "HTTPS 网址，请核对域名" : "明文 HTTP 网址";
  add("协议", parsed.protocol.replace(":", "").toUpperCase());
  add("域名", parsed.hostname || "（没有域名）");
  if (parsed.port) add("端口", parsed.port);
  if (parsed.pathname && parsed.pathname !== "/") add("路径", parsed.pathname);
  if (parsed.protocol === "http:") warn("warning", "未加密连接", "HTTP 传输可能被旁路观察或篡改，避免输入敏感信息。");
  if (parsed.username || parsed.password) {
    warn("danger", "网址含账号信息", "网址中嵌入了用户名或密码，本站不会提供打开按钮。");
  } else {
    result.openUrl = parsed.toString();
  }
  if (isIpHostname(parsed.hostname)) warn("warning", "直接使用 IP", "链接没有普通域名，更难确认归属。");
  if (parsed.hostname.toLowerCase().split(".").some((part) => part.startsWith("xn--"))) {
    warn("warning", "国际化域名", "域名使用 Punycode 编码，可能与熟悉的字母域名外观相近，请逐字核对。");
  }
  if (SHORTENER_HOSTS.has(parsed.hostname.toLowerCase())) warn("warning", "短网址", "短链接隐藏了最终去向，打开前无法仅凭当前域名判断目标。");
  if ([...parsed.searchParams.keys()].some((key) => /(token|secret|password|passwd|api[_-]?key|auth|session)/i.test(key))) {
    warn("warning", "敏感参数", "查询参数名称像是令牌、密码或会话信息，不要随意转发这个二维码。");
  }
  const cleaned = stripTrackingParameters(parsed.toString());
  if (cleaned.removed.length) {
    result.cleanUrl = cleaned.url;
    result.removedTracking = cleaned.removed;
    warn("notice", "跟踪参数", `发现 ${cleaned.removed.join("、")}，可复制移除后的链接。`);
  }
  result.severityLabel = SEVERITY_LABEL[result.severity];
  return result;
}

function escapeWifi(value) {
  return String(value).replace(/([\\;,:"])/g, "\\$1");
}

export function buildQrPayload(type, fields = {}) {
  if (type === "text") {
    const value = String(fields.text ?? "").trim();
    if (!value) throw new TypeError("请输入要生成二维码的文字。");
    if (value.length > 2000) throw new TypeError("文字不能超过 2000 个字符。");
    return value;
  }
  if (type === "url") {
    let value = String(fields.url ?? "").trim();
    if (!value) throw new TypeError("请输入网址。");
    if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = `https://${value}`;
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new TypeError("请输入完整的 HTTP 或 HTTPS 网址。");
    return parsed.toString();
  }
  if (type === "wifi") {
    const ssid = String(fields.ssid ?? "");
    const security = ["WPA", "WEP", "nopass"].includes(fields.security) ? fields.security : "WPA";
    const password = String(fields.password ?? "");
    if (!ssid) throw new TypeError("请输入 Wi-Fi 网络名称。");
    if (security !== "nopass" && !password) throw new TypeError("请输入 Wi-Fi 密码，或选择无密码网络。");
    const passwordPart = security === "nopass" ? "" : `P:${escapeWifi(password)};`;
    return `WIFI:T:${security};S:${escapeWifi(ssid)};${passwordPart}H:${fields.hidden ? "true" : "false"};;`;
  }
  throw new TypeError("不支持的二维码内容类型。");
}
async function copyText(value) {
  if (navigator.clipboard?.writeText) return await navigator.clipboard.writeText(value);
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.className = "qr-visually-hidden";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("浏览器没有允许复制，请手动选择文字。");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成 PNG 文件。")), "image/png"));
}

function initQrPrivacy() {
  const elements = {
    scanTab: document.querySelector("#scanTab"), generateTab: document.querySelector("#generateTab"),
    scanPanel: document.querySelector("#scanPanel"), generatePanel: document.querySelector("#generatePanel"),
    file: document.querySelector("#qrFile"), choose: document.querySelector("#chooseQrImage"), drop: document.querySelector("#qrDrop"),
    cameraStart: document.querySelector("#startCamera"), cameraStop: document.querySelector("#stopCamera"),
    cameraWrap: document.querySelector("#cameraWrap"), video: document.querySelector("#qrVideo"), scanStatus: document.querySelector("#scanStatus"),
    resultEmpty: document.querySelector("#qrResultEmpty"), result: document.querySelector("#qrResult"),
    resultKind: document.querySelector("#resultKind"), resultSummary: document.querySelector("#resultSummary"),
    resultRisk: document.querySelector("#resultRisk"), raw: document.querySelector("#rawResult"), details: document.querySelector("#qrDetails"),
    tracking: document.querySelector("#trackingClean"), cleanPreview: document.querySelector("#cleanUrlPreview"),
    cleanCopy: document.querySelector("#useCleanUrl"), copyResult: document.querySelector("#copyQrResult"), openLink: document.querySelector("#openQrLink"),
    generatorType: document.querySelector("#generatorType"), generatorUrl: document.querySelector("#generatorUrl"),
    generatorText: document.querySelector("#generatorText"), wifiName: document.querySelector("#wifiName"),
    wifiSecurity: document.querySelector("#wifiSecurity"), wifiPassword: document.querySelector("#wifiPassword"),
    wifiPasswordField: document.querySelector("#wifiPasswordField"), wifiHidden: document.querySelector("#wifiHidden"),
    generate: document.querySelector("#generateQr"), generateStatus: document.querySelector("#generateStatus"),
    canvas: document.querySelector("#qrCanvas"), canvasPlaceholder: document.querySelector("#qrCanvasPlaceholder"),
    payloadPreview: document.querySelector("#qrPayloadPreview"), png: document.querySelector("#downloadQrPng"),
    svg: document.querySelector("#downloadQrSvg"), copyPayload: document.querySelector("#copyQrPayload")
  };
  if (!elements.scanTab) return;

  let scanner = null;
  let scannedRaw = "";
  let cleanUrl = "";
  let generatedPayload = "";
  let generatedSvg = "";

  function setMode(mode) {
    const scan = mode === "scan";
    elements.scanTab.setAttribute("aria-selected", String(scan));
    elements.generateTab.setAttribute("aria-selected", String(!scan));
    elements.scanPanel.hidden = !scan;
    elements.generatePanel.hidden = scan;
    if (!scan) stopCamera();
  }

  elements.scanTab.addEventListener("click", () => setMode("scan"));
  elements.generateTab.addEventListener("click", () => setMode("generate"));

  function renderAnalysis(raw) {
    const analysis = analyzeQrContent(raw);
    scannedRaw = analysis.raw;
    cleanUrl = analysis.cleanUrl || "";
    elements.resultEmpty.hidden = true;
    elements.result.hidden = false;
    elements.resultKind.textContent = analysis.kind;
    elements.resultSummary.textContent = analysis.summary;
    elements.resultRisk.className = `qr-risk ${analysis.severity}`;
    elements.resultRisk.textContent = analysis.severityLabel;
    elements.raw.textContent = analysis.raw || "（空内容）";
    elements.details.replaceChildren();
    for (const detail of analysis.details) {
      const row = document.createElement("div");
      row.className = `qr-detail-row ${detail.level === "neutral" ? "" : detail.level}`.trim();
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = detail.label;
      description.textContent = detail.value;
      row.append(term, description);
      elements.details.append(row);
    }
    elements.tracking.hidden = !analysis.cleanUrl;
    elements.cleanPreview.textContent = analysis.cleanUrl || "";
    elements.openLink.hidden = !analysis.openUrl || analysis.severity === "danger";
    if (analysis.openUrl && analysis.severity !== "danger") elements.openLink.href = analysis.openUrl;
    else elements.openLink.removeAttribute("href");
  }

  async function stopCamera(message = "摄像头已关闭。") {
    if (scanner) scanner.stop();
    elements.cameraWrap.hidden = true;
    elements.cameraStart.disabled = false;
    if (!elements.scanStatus.classList.contains("success")) elements.scanStatus.textContent = message;
  }

  async function scanFile(file) {
    if (!(file instanceof Blob)) return;
    if (file.size > MAX_IMAGE_BYTES) {
      elements.scanStatus.className = "scan-status error";
      elements.scanStatus.textContent = "图片超过 20 MB，请先缩小后再识别。";
      return;
    }
    elements.scanStatus.className = "scan-status";
    elements.scanStatus.textContent = "正在本机识别图片…";
    try {
      const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true, alsoTryWithoutScanRegion: true });
      renderAnalysis(result.data);
      elements.scanStatus.className = "scan-status success";
      elements.scanStatus.textContent = "识别完成，图片没有上传。";
    } catch {
      elements.scanStatus.className = "scan-status error";
      elements.scanStatus.textContent = "没有识别到二维码。请换一张更清晰、边缘完整的图片。";
    }
  }

  elements.choose.addEventListener("click", (event) => { event.stopPropagation(); elements.file.click(); });
  elements.file.addEventListener("change", () => {
    const file = elements.file.files?.[0];
    if (file) scanFile(file);
    elements.file.value = "";
  });
  elements.drop.addEventListener("click", (event) => { if (!event.target.closest("button")) elements.file.click(); });
  elements.drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); elements.file.click(); }
  });
  for (const eventName of ["dragenter", "dragover"]) {
    elements.drop.addEventListener(eventName, (event) => { event.preventDefault(); elements.drop.classList.add("is-dragging"); });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements.drop.addEventListener(eventName, (event) => { event.preventDefault(); elements.drop.classList.remove("is-dragging"); });
  }
  elements.drop.addEventListener("drop", (event) => {
    const file = [...(event.dataTransfer?.files || [])].find((candidate) => candidate.type.startsWith("image/"));
    if (file) scanFile(file);
  });
  document.addEventListener("paste", (event) => {
    if (elements.scanPanel.hidden) return;
    const file = [...(event.clipboardData?.files || [])].find((candidate) => candidate.type.startsWith("image/"));
    if (file) scanFile(file);
  });

  elements.cameraStart.addEventListener("click", async () => {
    elements.cameraStart.disabled = true;
    elements.scanStatus.className = "scan-status";
    elements.scanStatus.textContent = "正在请求摄像头权限…";
    try {
      if (!window.isSecureContext) throw new Error("摄像头只能在 HTTPS 页面使用。");
      if (!await QrScanner.hasCamera()) throw new Error("没有找到可用的摄像头。");
      if (!scanner) {
        scanner = new QrScanner(elements.video, (result) => {
          renderAnalysis(result.data);
          elements.scanStatus.className = "scan-status success";
          elements.scanStatus.textContent = "识别完成，摄像头已自动关闭。";
          stopCamera();
        }, {
          returnDetailedScanResult: true,
          highlightScanRegion: true,
          highlightCodeOutline: true,
          preferredCamera: "environment",
          onDecodeError: () => {}
        });
      }
      elements.cameraWrap.hidden = false;
      await scanner.start();
      elements.scanStatus.textContent = "摄像头已开启，请把二维码放进画面。";
    } catch (caught) {
      elements.cameraWrap.hidden = true;
      elements.cameraStart.disabled = false;
      elements.scanStatus.className = "scan-status error";
      elements.scanStatus.textContent = caught?.message || "无法开启摄像头，请检查浏览器权限。";
    }
  });
  elements.cameraStop.addEventListener("click", () => stopCamera());
  elements.copyResult.addEventListener("click", async () => {
    try { await copyText(scannedRaw); elements.scanStatus.className = "scan-status success"; elements.scanStatus.textContent = "原始内容已复制。"; }
    catch (caught) { elements.scanStatus.className = "scan-status error"; elements.scanStatus.textContent = caught.message; }
  });
  elements.cleanCopy.addEventListener("click", async () => {
    try { await copyText(cleanUrl); elements.scanStatus.className = "scan-status success"; elements.scanStatus.textContent = "去跟踪链接已复制。"; }
    catch (caught) { elements.scanStatus.className = "scan-status error"; elements.scanStatus.textContent = caught.message; }
  });
  function syncGeneratorFields() {
    const type = elements.generatorType.value;
    for (const group of document.querySelectorAll("[data-generator-fields]")) group.hidden = group.dataset.generatorFields !== type;
  }
  elements.generatorType.addEventListener("change", syncGeneratorFields);
  elements.wifiSecurity.addEventListener("change", () => {
    elements.wifiPasswordField.hidden = elements.wifiSecurity.value === "nopass";
  });
  syncGeneratorFields();

  elements.generate.addEventListener("click", async () => {
    elements.generate.disabled = true;
    elements.generateStatus.className = "generate-status";
    elements.generateStatus.textContent = "正在本机生成二维码…";
    try {
      const type = elements.generatorType.value;
      const payload = buildQrPayload(type, {
        url: elements.generatorUrl.value,
        text: elements.generatorText.value,
        ssid: elements.wifiName.value,
        security: elements.wifiSecurity.value,
        password: elements.wifiPassword.value,
        hidden: elements.wifiHidden.checked
      });
      const options = { width: 512, margin: 2, errorCorrectionLevel: "M", color: { dark: "#17202e", light: "#fffdf9" } };
      await QRCode.toCanvas(elements.canvas, payload, options);
      generatedSvg = await QRCode.toString(payload, { ...options, type: "svg" });
      generatedPayload = payload;
      elements.canvas.classList.add("ready");
      elements.canvasPlaceholder.hidden = true;
      elements.payloadPreview.textContent = payload;
      elements.png.disabled = false;
      elements.svg.disabled = false;
      elements.copyPayload.disabled = false;
      elements.generateStatus.className = "generate-status success";
      elements.generateStatus.textContent = "二维码已在本机生成。";
    } catch (caught) {
      generatedPayload = "";
      generatedSvg = "";
      elements.png.disabled = true;
      elements.svg.disabled = true;
      elements.copyPayload.disabled = true;
      elements.generateStatus.className = "generate-status error";
      elements.generateStatus.textContent = caught?.message || "无法生成二维码，请缩短内容后再试。";
    } finally {
      elements.generate.disabled = false;
    }
  });

  elements.png.addEventListener("click", async () => {
    if (!generatedPayload) return;
    try { downloadBlob(await canvasToBlob(elements.canvas), "二维码.png"); }
    catch (caught) { elements.generateStatus.className = "generate-status error"; elements.generateStatus.textContent = caught.message; }
  });
  elements.svg.addEventListener("click", () => {
    if (generatedSvg) downloadBlob(new Blob([generatedSvg], { type: "image/svg+xml;charset=utf-8" }), "二维码.svg");
  });
  elements.copyPayload.addEventListener("click", async () => {
    try { await copyText(generatedPayload); elements.generateStatus.className = "generate-status success"; elements.generateStatus.textContent = "二维码内容已复制。"; }
    catch (caught) { elements.generateStatus.className = "generate-status error"; elements.generateStatus.textContent = caught.message; }
  });

  window.addEventListener("pagehide", () => {
    if (scanner) { scanner.destroy(); scanner = null; }
  });
}

if (typeof document !== "undefined") initQrPrivacy();