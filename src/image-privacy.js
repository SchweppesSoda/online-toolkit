// Metadata engine: ExifReader 4.41.3 by Mattias Wallander and contributors.
// Source: https://github.com/mattiasw/ExifReader — MPL-2.0. See THIRD_PARTY_NOTICES.md.
import ExifReader from "exifreader";

const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 80_000_000;
const CATEGORY_LABELS = {
  location: "位置与行程",
  identity: "身份与版权",
  device: "设备与软件",
  time: "拍摄与修改时间",
  content: "标题、描述与内容",
  technical: "普通技术参数"
};
const CATEGORY_ORDER = ["location", "identity", "device", "time", "content", "technical"];

function searchableTagName(name) {
  return String(name)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

export function categorizeMetadataTag(name) {
  const value = searchableTagName(name);
  if (/\b(gps|geo|latitude|longitude|altitude|location|destination|position)\b/.test(value)) return "location";
  if (/\b(artist|author|creator|owner|copyright|serial|by line|contact|credit|writer|person)\b/.test(value)) return "identity";
  if (/\b(make|model|lens|software|firmware|device|camera|host computer|maker note|processing)\b/.test(value)) return "device";
  if (/\b(date|time|timestamp|timezone|offset time)\b/.test(value)) return "time";
  if (/\b(comment|description|title|subject|keyword|rating|caption|headline|instruction|label)\b/.test(value)) return "content";
  return "technical";
}

function binaryDescription(value) {
  if (value instanceof ArrayBuffer) return `${value.byteLength} 字节二进制数据`;
  if (ArrayBuffer.isView(value)) return `${value.byteLength} 字节二进制数据`;
  return null;
}

export function metadataValue(tag) {
  if (tag === null || tag === undefined) return "";
  const candidate = typeof tag === "object" && "description" in tag ? tag.description : tag;
  const binary = binaryDescription(candidate);
  if (binary) return binary;
  if (["string", "number", "boolean", "bigint"].includes(typeof candidate)) {
    return String(candidate).trim().slice(0, 500);
  }
  if (Array.isArray(candidate)) {
    if (candidate.length > 32 || candidate.some((item) => typeof item === "object")) return `${candidate.length} 项数据`;
    return candidate.join(", ").slice(0, 500);
  }
  if (typeof tag === "object" && "value" in tag) {
    const raw = tag.value;
    const rawBinary = binaryDescription(raw);
    if (rawBinary) return rawBinary;
    if (["string", "number", "boolean", "bigint"].includes(typeof raw)) return String(raw).slice(0, 500);
    if (Array.isArray(raw) && raw.length <= 32 && raw.every((item) => typeof item !== "object")) return raw.join(", ").slice(0, 500);
  }
  return "结构化或二进制数据";
}

export function buildMetadataReport(tags = {}) {
  const items = Object.entries(tags)
    .filter(([name]) => !/^Thumbnail$/i.test(name))
    .map(([name, tag]) => ({ name, value: metadataValue(tag) || "（空）", category: categorizeMetadataTag(name) }))
    .sort((left, right) => CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category));
  const privacyItems = items.filter((item) => item.category !== "technical");
  const highRiskItems = privacyItems.filter((item) => ["location", "identity"].includes(item.category));
  return { items, privacyItems, risk: highRiskItems.length ? "high" : privacyItems.length ? "medium" : "safe" };
}

export function cleanFilename(filename, mimeType) {
  const fallbackExtension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const raw = String(filename || "image");
  const dot = raw.lastIndexOf(".");
  const base = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[\\/:*?"<>|]+/g, "-").trim() || "image";
  const extension = dot > 0 ? raw.slice(dot + 1).toLowerCase() : fallbackExtension;
  const normalizedExtension = ["jpg", "jpeg", "png", "webp"].includes(extension) ? extension : fallbackExtension;
  return `${base}-已清理.${normalizedExtension}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

async function readTags(file) {
  try {
    const input = file instanceof Blob ? await file.arrayBuffer() : file;
    return await ExifReader.load(input);
  } catch (caught) {
    if (caught instanceof ExifReader.errors.MetadataMissingError) return {};
    throw caught;
  }
}

function validateFile(file) {
  if (!(file instanceof Blob)) throw new TypeError("没有读取到图片文件。");
  if (!SUPPORTED_TYPES.has(file.type)) throw new TypeError("目前只支持 JPG、PNG 和 WebP 图片。");
  if (file.size > MAX_FILE_BYTES) throw new TypeError("图片超过 50 MB，请先缩小文件后再试。");
}

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch { bitmap = await createImageBitmap(file); }
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (caught) {
    URL.revokeObjectURL(url);
    throw caught;
  }
}

async function imageFacts(file) {
  const decoded = await decodeImage(file);
  const facts = { width: decoded.width, height: decoded.height };
  decoded.release();
  return facts;
}

async function canvasBlob(canvas, type, quality) {
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("浏览器无法生成这种格式的图片。")), type, quality);
  });
}

export async function createCleanCopy(file) {
  validateFile(file);
  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_PIXELS) {
      throw new Error("图片像素过大，浏览器无法安全地完整重绘。请先缩小分辨率后再试。");
    }
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const context = canvas.getContext("2d", { alpha: file.type !== "image/jpeg" });
    if (!context) throw new Error("当前浏览器无法创建图片画布。");
    if (file.type === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    return await canvasBlob(canvas, file.type, file.type === "image/png" ? undefined : 0.95);
  } finally {
    decoded.release();
  }
}
function setRisk(element, risk, count) {
  element.className = `risk-pill ${risk}`;
  if (risk === "high") element.textContent = `${count} 项高风险信息`;
  else if (risk === "medium") element.textContent = `${count} 项隐私信息`;
  else element.textContent = "未发现隐私元数据";
}

function addFact(container, label, value) {
  const item = document.createElement("div");
  const name = document.createElement("span");
  const detail = document.createElement("strong");
  name.textContent = label;
  detail.textContent = value;
  item.append(name, detail);
  container.append(item);
}

function renderMetadata(container, report, emptyMessage) {
  container.replaceChildren();
  const grouped = new Map(CATEGORY_ORDER.map((category) => [category, []]));
  for (const item of report.items) grouped.get(item.category).push(item);
  let rendered = 0;
  for (const category of CATEGORY_ORDER) {
    const items = grouped.get(category);
    if (!items.length) continue;
    const section = document.createElement("section");
    section.className = "metadata-group";
    const heading = document.createElement("h3");
    heading.textContent = CATEGORY_LABELS[category];
    const count = document.createElement("span");
    count.textContent = `${items.length} 项`;
    heading.append(count);
    const list = document.createElement("dl");
    list.className = "metadata-list";
    for (const item of items.slice(0, 12)) {
      const row = document.createElement("div");
      row.className = "metadata-row";
      const term = document.createElement("dt");
      const value = document.createElement("dd");
      term.textContent = item.name;
      value.textContent = item.value;
      row.append(term, value);
      list.append(row);
    }
    section.append(heading, list);
    if (items.length > 12) {
      const more = document.createElement("p");
      more.className = "metadata-more";
      more.textContent = `另有 ${items.length - 12} 项未展开`;
      section.append(more);
    }
    container.append(section);
    rendered += items.length;
  }
  if (!rendered) {
    const empty = document.createElement("div");
    empty.className = "report-empty";
    empty.textContent = emptyMessage;
    container.append(empty);
  }
  container.hidden = false;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initImagePrivacy() {
  const elements = {
    input: document.querySelector("#imageFile"), drop: document.querySelector("#imageDrop"),
    choose: document.querySelector("#chooseImage"), replace: document.querySelector("#replaceImage"),
    dropEmpty: document.querySelector("#dropEmpty"), previewWrap: document.querySelector("#imagePreviewWrap"),
    preview: document.querySelector("#imagePreview"), caption: document.querySelector("#imageCaption"),
    clean: document.querySelector("#cleanImage"), status: document.querySelector("#cleanStatus"),
    originalTitle: document.querySelector("#originalReportTitle"), originalRisk: document.querySelector("#originalRisk"),
    originalEmpty: document.querySelector("#originalEmpty"), originalMetadata: document.querySelector("#originalMetadata"),
    facts: document.querySelector("#fileFacts"), resultTitle: document.querySelector("#resultTitle"),
    cleanRisk: document.querySelector("#cleanRisk"), cleanMetadata: document.querySelector("#cleanMetadata"),
    verification: document.querySelector("#verification"), download: document.querySelector("#downloadClean")
  };
  if (!elements.input) return;

  let currentFile = null;
  let cleanBlob = null;
  let previewUrl = "";
  let generation = 0;

  function resetCleanResult() {
    cleanBlob = null;
    elements.download.disabled = true;
    elements.resultTitle.textContent = "等待生成";
    elements.cleanRisk.className = "risk-pill neutral";
    elements.cleanRisk.textContent = "未复检";
    elements.cleanMetadata.hidden = true;
    elements.cleanMetadata.replaceChildren();
    elements.verification.className = "verification";
    elements.verification.querySelector("strong").textContent = "只有复检通过，才会标记为已清理";
    elements.verification.querySelector("p").textContent = "技术参数（例如图片宽高、编码格式）不算隐私元数据。";
  }

  async function selectFile(file) {
    const selection = ++generation;
    resetCleanResult();
    elements.clean.disabled = true;
    elements.status.className = "action-status";
    elements.status.textContent = "正在本机读取图片和元数据…";
    try {
      validateFile(file);
      const [tags, dimensions] = await Promise.all([readTags(file), imageFacts(file)]);
      if (selection !== generation) return;
      currentFile = file;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      elements.preview.src = previewUrl;
      elements.caption.textContent = file.name || "剪贴板图片";
      elements.dropEmpty.hidden = true;
      elements.previewWrap.hidden = false;
      elements.replace.hidden = false;

      const report = buildMetadataReport(tags);
      elements.originalTitle.textContent = report.privacyItems.length ? `发现 ${report.privacyItems.length} 项隐私信息` : "未发现常见隐私元数据";
      setRisk(elements.originalRisk, report.risk, report.privacyItems.length);
      elements.originalEmpty.hidden = true;
      renderMetadata(elements.originalMetadata, report, "没有读取到附带元数据。图片仍可重新编码并复检。");
      elements.facts.replaceChildren();
      addFact(elements.facts, "文件", file.name || "剪贴板图片");
      addFact(elements.facts, "格式", file.type.replace("image/", "").toUpperCase());
      addFact(elements.facts, "尺寸", `${dimensions.width} × ${dimensions.height}`);
      addFact(elements.facts, "大小", formatBytes(file.size));
      elements.facts.hidden = false;
      elements.clean.disabled = false;
      elements.status.textContent = report.privacyItems.length ? "检查完成。可以生成干净副本。" : "未发现常见隐私元数据；仍可生成并复检一个干净副本。";
    } catch (caught) {
      if (selection !== generation) return;
      currentFile = null;
      elements.clean.disabled = true;
      elements.status.className = "action-status error";
      elements.status.textContent = caught?.message || "无法读取这张图片。";
      elements.originalTitle.textContent = "检查失败";
      elements.originalRisk.className = "risk-pill high";
      elements.originalRisk.textContent = "无法确认";
    }
  }

  elements.choose.addEventListener("click", (event) => { event.stopPropagation(); elements.input.click(); });
  elements.replace.addEventListener("click", () => elements.input.click());
  elements.input.addEventListener("change", () => {
    const file = elements.input.files?.[0];
    if (file) selectFile(file);
    elements.input.value = "";
  });
  elements.drop.addEventListener("click", (event) => {
    if (!event.target.closest("button") && !currentFile) elements.input.click();
  });
  elements.drop.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !currentFile) { event.preventDefault(); elements.input.click(); }
  });
  for (const eventName of ["dragenter", "dragover"]) {
    elements.drop.addEventListener(eventName, (event) => { event.preventDefault(); elements.drop.classList.add("is-dragging"); });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements.drop.addEventListener(eventName, (event) => { event.preventDefault(); elements.drop.classList.remove("is-dragging"); });
  }
  elements.drop.addEventListener("drop", (event) => {
    const file = [...(event.dataTransfer?.files || [])].find((candidate) => candidate.type.startsWith("image/"));
    if (file) selectFile(file);
  });
  document.addEventListener("paste", (event) => {
    const file = [...(event.clipboardData?.files || [])].find((candidate) => candidate.type.startsWith("image/"));
    if (file) selectFile(file);
  });

  elements.clean.addEventListener("click", async () => {
    if (!currentFile) return;
    const selection = ++generation;
    elements.clean.disabled = true;
    elements.download.disabled = true;
    elements.status.className = "action-status";
    elements.status.textContent = "正在重绘像素并复检新副本…";
    try {
      const blob = await createCleanCopy(currentFile);
      const tags = await readTags(blob);
      if (selection !== generation) return;
      const report = buildMetadataReport(tags);
      cleanBlob = blob;
      renderMetadata(elements.cleanMetadata, report, "复检没有读到任何附带元数据。");
      elements.resultTitle.textContent = report.privacyItems.length ? "复检仍发现隐私信息" : "复检通过";
      setRisk(elements.cleanRisk, report.risk, report.privacyItems.length);
      if (report.privacyItems.length === 0) {
        elements.verification.className = "verification verified";
        elements.verification.querySelector("strong").textContent = "已确认：常见隐私元数据已移除";
        elements.verification.querySelector("p").textContent = `新副本 ${formatBytes(blob.size)}；只保留了图片像素与必要的编码参数。`;
        elements.download.disabled = false;
        elements.status.className = "action-status success";
        elements.status.textContent = "复检通过，可以下载干净副本。";
      } else {
        elements.verification.className = "verification failed";
        elements.verification.querySelector("strong").textContent = "没有标记为已清理";
        elements.verification.querySelector("p").textContent = "复检仍发现隐私字段。为了避免误导，本站不会把这个副本标记为安全。";
        elements.status.className = "action-status error";
        elements.status.textContent = "复检未通过，请不要把这个结果当作已清理图片。";
      }
    } catch (caught) {
      if (selection !== generation) return;
      elements.resultTitle.textContent = "生成或复检失败";
      elements.cleanRisk.className = "risk-pill high";
      elements.cleanRisk.textContent = "无法确认";
      elements.verification.className = "verification failed";
      elements.verification.querySelector("strong").textContent = "没有生成可验证的副本";
      elements.verification.querySelector("p").textContent = caught?.message || "当前浏览器无法完整处理这张图片。";
      elements.status.className = "action-status error";
      elements.status.textContent = caught?.message || "处理失败。";
    } finally {
      if (selection === generation) elements.clean.disabled = !currentFile;
    }
  });

  elements.download.addEventListener("click", () => {
    if (cleanBlob && currentFile) downloadBlob(cleanBlob, cleanFilename(currentFile.name, currentFile.type));
  });
  window.addEventListener("pagehide", () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
}

if (typeof document !== "undefined") initImagePrivacy();