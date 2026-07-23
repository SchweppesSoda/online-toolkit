import { Scanner, createCornerEditor, extractDocument } from "scanic";
import {
  createScanSource,
  defaultCorners,
  reliableDetection,
  sourceDimensions
} from "./image-utils.js";

(() => {
      "use strict";

      const MAX_FILES = 6;
      const MAX_SIZE = 40 * 1024 * 1024;
      const PREVIEW_LIMIT = 1800;

      const state = {
        items: [],
        active: -1,
        layout: "tile",
        color: "#bd3f32",
        opacity: .26,
        size: 32,
        space: 1.1,
        angle: -24,
        date: false,
        dateFormat: "dot",
        format: "png",
        targetBytes: 0,
        quality: .92,
        original: false,
        frame: 0,
        busy: false,
        scanner: null,
        scanEditor: null,
        scanItem: null,
        scanSource: null,
        scanRequest: 0
      };

      const $ = (id) => document.getElementById(id);
      const el = {
        file: $("fileInput"), choose: $("choose"), demo: $("demo"), add: $("add"),
        remove: $("remove"), compare: $("compare"), scanCurrent: $("scanCurrent"),
        restoreOriginal: $("restoreOriginal"), drop: $("drop"), stage: $("stage"),
        wrap: $("canvasWrap"), canvas: $("canvas"), thumbs: $("thumbs"), info: $("fileInfo"),
        text: $("watermarkText"), count: $("charCount"), date: $("includeDate"),
        dateOptions: $("dateOptions"), dateButtons: $("dateButtons"),
        layouts: $("layoutButtons"), colors: $("colorButtons"), custom: $("customColor"),
        colorName: $("colorName"), opacity: $("opacity"), opacityOut: $("opacityOut"),
        size: $("size"), sizeOut: $("sizeOut"), space: $("space"), spaceOut: $("spaceOut"),
        angle: $("angle"), angleOut: $("angleOut"), formats: $("formatButtons"),
        jpgOptions: $("jpgOptions"), sizeButtons: $("sizeButtons"),
        qualityRow: $("qualityRow"), quality: $("quality"), qualityOut: $("qualityOut"),
        exportCurrent: $("exportCurrent"), exportAll: $("exportAll"), exportLabel: $("exportLabel"),
        scanDialog: $("scanDialog"), scanHost: $("scanHost"), scanStatus: $("scanStatus"),
        scanClose: $("scanClose"), scanCancel: $("scanCancel"), scanReset: $("scanReset"),
        scanApply: $("scanApply"), toast: $("toast")
      };

      let toastTimer = 0;

      function toast(message) {
        clearTimeout(toastTimer);
        el.toast.textContent = message;
        el.toast.classList.add("show");
        toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
      }

      function dateText() {
        const d = new Date();
        const year = d.getFullYear();
        const month = d.getMonth() + 1;
        const day = d.getDate();
        const pad = (n) => String(n).padStart(2, "0");
        if (state.dateFormat === "dash") return `${year}-${pad(month)}-${pad(day)}`;
        if (state.dateFormat === "slash") return `${year}/${pad(month)}/${pad(day)}`;
        if (state.dateFormat === "cn") return `${year}年${month}月${day}日`;
        if (state.dateFormat === "dmy") return `${pad(day)}/${pad(month)}/${year}`;
        return `${year}.${pad(month)}.${pad(day)}`;
      }

      function lines() {
        const result = el.text.value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
        if (state.date) result.push(dateText());
        return result.length ? result : ["仅用于指定用途", "他用无效"];
      }

      function schedule() {
        cancelAnimationFrame(state.frame);
        state.frame = requestAnimationFrame(renderPreview);
      }

      function textBlock(ctx, values, x, y, fontSize, lineHeight) {
        const height = (values.length - 1) * lineHeight;
        values.forEach((value, index) => ctx.fillText(value, x, y - height / 2 + index * lineHeight));
      }

      function watermark(ctx, width, height) {
        if (state.original) return;
        const values = lines();
        const base = Math.min(width, height);
        const fontSize = Math.max(14, base * state.size / 1000);
        const lineHeight = fontSize * 1.42;
        const radians = state.angle * Math.PI / 180;

        ctx.save();
        ctx.globalAlpha = state.opacity;
        ctx.fillStyle = state.color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `700 ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;

        if (state.layout === "center") {
          const focus = fontSize * 1.7;
          ctx.font = `700 ${focus}px "Microsoft YaHei", "PingFang SC", sans-serif`;
          ctx.translate(width / 2, height / 2);
          ctx.rotate(radians);
          textBlock(ctx, values, 0, 0, focus, focus * 1.45);
          ctx.restore();
          return;
        }

        if (state.layout === "bands") {
          const maxWidth = Math.max(...values.map((value) => ctx.measureText(value).width));
          const step = Math.max(maxWidth + fontSize * 3 * state.space, width * .44);
          [.27, .5, .73].forEach((ratio, row) => {
            for (let x = -step; x <= width + step; x += step) {
              ctx.save();
              ctx.translate(x + (row % 2 ? step / 2 : 0), height * ratio);
              ctx.rotate(radians);
              textBlock(ctx, values, 0, 0, fontSize, lineHeight);
              ctx.restore();
            }
          });
          ctx.restore();
          return;
        }

        const diagonal = Math.hypot(width, height);
        const maxWidth = Math.max(...values.map((value) => ctx.measureText(value).width));
        const stepX = Math.max(maxWidth + fontSize * 3.6 * state.space, fontSize * 10);
        const stepY = Math.max(lineHeight * values.length + fontSize * 3.2 * state.space, fontSize * 5.2);
        ctx.translate(width / 2, height / 2);
        ctx.rotate(radians);
        let row = 0;
        for (let y = -diagonal; y <= diagonal; y += stepY) {
          const offset = row % 2 ? stepX / 2 : 0;
          for (let x = -diagonal; x <= diagonal; x += stepX) {
            textBlock(ctx, values, x + offset, y, fontSize, lineHeight);
          }
          row += 1;
        }
        ctx.restore();
      }

      function itemSource(item) {
        return item.corrected || item.image;
      }

      function releaseCorrected(item) {
        if (item.correctedUrl) URL.revokeObjectURL(item.correctedUrl);
        item.corrected = null;
        item.correctedUrl = "";
      }

      function draw(canvas, item, limit) {
        const source = itemSource(item);
        const { width: sourceWidth, height: sourceHeight } = sourceDimensions(source);
        const ratio = limit ? Math.min(1, limit / Math.max(sourceWidth, sourceHeight)) : 1;
        const width = Math.max(1, Math.round(sourceWidth * ratio));
        const height = Math.max(1, Math.round(sourceHeight * ratio));
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, width, height);
        watermark(ctx, width, height);
      }

      function renderPreview() {
        const item = state.items[state.active];
        if (item) draw(el.canvas, item, PREVIEW_LIMIT);
      }

      function bytes(value) {
        if (!value) return "演示图片";
        if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
        return `${(value / 1024 / 1024).toFixed(1)} MB`;
      }

      function updateInfo() {
        const item = state.items[state.active];
        if (!item) {
          const strong = document.createElement("strong");
          strong.textContent = "等待添加证件图片";
          const span = document.createElement("span");
          span.textContent = "支持 JPG、PNG、WebP，单张不超过 40 MB";
          el.info.replaceChildren(strong, span);
          return;
        }
        const strong = document.createElement("strong");
        strong.textContent = item.corrected ? `${item.name} · 已矫正` : item.name;
        const span = document.createElement("span");
        const dimensions = sourceDimensions(itemSource(item));
        span.textContent = `${dimensions.width} × ${dimensions.height} · ${bytes(item.size)} · 第 ${state.active + 1}/${state.items.length} 张`;
        el.info.replaceChildren(strong, span);
      }

      function renderThumbs() {
        el.thumbs.replaceChildren();
        el.thumbs.hidden = !state.items.length;
        state.items.forEach((item, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "thumb";
          button.setAttribute("aria-label", `查看 ${item.name}`);
          button.setAttribute("aria-pressed", String(index === state.active));
          const image = document.createElement("img");
          image.src = item.correctedUrl || item.url;
          image.alt = "";
          button.append(image);
          button.addEventListener("click", () => {
            state.active = index;
            update();
          });
          el.thumbs.append(button);
        });
      }

      function update() {
        const has = state.items.length > 0;
        const current = state.items[state.active];
        el.drop.hidden = has;
        el.wrap.hidden = !has;
        el.compare.disabled = !has;
        el.remove.disabled = !has;
        el.scanCurrent.disabled = !has || state.busy;
        el.scanCurrent.querySelector(".wide").textContent = current?.corrected ? "重新裁剪" : "智能裁剪";
        el.scanCurrent.title = current?.corrected
          ? "从原始图片重新识别并执行透视矫正"
          : "自动寻找证件四角并进行透视矫正";
        el.restoreOriginal.hidden = !current?.corrected;
        el.restoreOriginal.disabled = !has || state.busy;
        el.exportCurrent.disabled = !has || state.busy;
        el.exportAll.hidden = state.items.length < 2;
        el.exportAll.disabled = !has || state.busy;
        el.exportAll.textContent = `下载全部 ${state.items.length} 张`;
        updateInfo();
        renderThumbs();
        if (has) schedule();
      }

      function decode(file) {
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const image = new Image();
          image.decoding = "async";
          image.onload = () => resolve({
            image,
            url,
            name: file.name || "粘贴图片",
            size: file.size || 0,
            corrected: null,
            correctedUrl: ""
          });
          image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("无法读取图片"));
          };
          image.src = url;
        });
      }

      async function addFiles(fileList) {
        const room = MAX_FILES - state.items.length;
        if (room <= 0) return toast(`最多同时处理 ${MAX_FILES} 张图片`);
        const files = Array.from(fileList).filter((file) => {
          if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
            toast(`已跳过不支持的文件：${file.name || "未知文件"}`);
            return false;
          }
          if (file.size > MAX_SIZE) {
            toast(`文件过大：${file.name}`);
            return false;
          }
          return true;
        }).slice(0, room);
        if (!files.length) return;
        const results = await Promise.allSettled(files.map(decode));
        const added = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
        if (!added.length) return toast("没有可读取的图片");
        state.items.push(...added);
        state.active = state.items.length - added.length;
        el.file.value = "";
        update();
        toast(`已在本机载入 ${added.length} 张图片`);
      }

      function remove() {
        const item = state.items[state.active];
        if (!item) return;
        releaseCorrected(item);
        URL.revokeObjectURL(item.url);
        state.items.splice(state.active, 1);
        state.active = state.items.length ? Math.min(state.active, state.items.length - 1) : -1;
        update();
        toast("已从当前页面移除图片");
      }

      function restoreOriginal() {
        const item = state.items[state.active];
        if (!item?.corrected) return;
        releaseCorrected(item);
        update();
        toast("已恢复当前图片的原始版本");
      }

      function setScanBusy(busy, message) {
        el.scanDialog.classList.toggle("busy", busy);
        el.scanApply.disabled = busy || !state.scanEditor;
        el.scanReset.disabled = busy || !state.scanEditor;
        if (message) el.scanStatus.textContent = message;
      }

      function destroyScanEditor() {
        state.scanEditor?.destroy();
        state.scanEditor = null;
        el.scanHost.replaceChildren();
      }

      function mountScanEditor(source, corners) {
        destroyScanEditor();
        state.scanEditor = createCornerEditor({
          container: el.scanHost,
          image: source,
          corners,
          toolbar: { enabled: false },
          nudges: { enabled: false },
          keyboard: true,
          handleHitArea: 52,
          magnifier: {
            enabled: true,
            size: 118,
            zoom: 2.4,
            margin: 18
          }
        });
      }

      function closeScan() {
        state.scanRequest += 1;
        destroyScanEditor();
        state.scanItem = null;
        state.scanSource = null;
        el.scanDialog.classList.remove("busy");
        if (el.scanDialog.open) el.scanDialog.close();
      }

      async function openScan() {
        const item = state.items[state.active];
        if (!item || state.busy) return;
        const request = ++state.scanRequest;
        state.scanItem = item;
        state.scanSource = createScanSource(item.image);
        el.scanStatus.textContent = "正在本机寻找证件边缘…";
        el.scanApply.disabled = true;
        el.scanReset.disabled = true;
        el.scanDialog.showModal();
        el.scanDialog.classList.add("busy");

        try {
          state.scanner ||= new Scanner();
          await state.scanner.initialize();
          const detection = await state.scanner.scan(state.scanSource, {
            mode: "detect",
            maxProcessingDimension: 1200,
            enableDetectionCascade: true
          });
          if (request !== state.scanRequest || !el.scanDialog.open) return;
          const detected = reliableDetection(detection, state.scanSource);
          const corners = detected
            ? detection.corners
            : defaultCorners(state.scanSource);
          mountScanEditor(state.scanSource, corners);
          if (detected) {
            const confidence = Number.isFinite(detection.confidence)
              ? `，置信度 ${Math.round(detection.confidence * 100)}%`
              : "";
            setScanBusy(false, `已自动找到四角${confidence}；请检查并拖动校准。`);
          } else {
            setScanBusy(false, "未可靠识别出完整证件，已提供默认角点；请手动拖动校准。");
          }
        } catch (error) {
          console.error(error);
          if (request !== state.scanRequest || !el.scanDialog.open) return;
          mountScanEditor(state.scanSource, defaultCorners(state.scanSource));
          setScanBusy(false, "自动识别未完成，已切换为手动四角校准。");
        }
      }

      async function applyScan() {
        const item = state.scanItem;
        const source = state.scanSource;
        const editor = state.scanEditor;
        if (!item || !source || !editor) return;
        const request = state.scanRequest;
        setScanBusy(true, "正在本机执行高清透视矫正…");
        try {
          const result = await extractDocument(source, editor.getCorners(), { output: "canvas" });
          if (!result.success || !(result.output instanceof HTMLCanvasElement)) {
            throw new Error(result.message || "透视矫正失败");
          }
          const previewBlob = await toBlob(result.output, "image/jpeg", .86);
          if (request !== state.scanRequest) return;
          releaseCorrected(item);
          item.corrected = result.output;
          item.correctedUrl = URL.createObjectURL(previewBlob);
          const dimensions = sourceDimensions(result.output);
          closeScan();
          update();
          toast(`已矫正当前图片 · ${dimensions.width}×${dimensions.height}`);
        } catch (error) {
          console.error(error);
          setScanBusy(false, "矫正失败，请重新调整四角后再试。");
          toast("透视矫正失败，请检查四个角点");
        }
      }

      function pressed(container, selected) {
        container.querySelectorAll("[aria-pressed]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button === selected));
        });
      }

      function roundRect(ctx, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + width, y, x + width, y + height, r);
        ctx.arcTo(x + width, y + height, x, y + height, r);
        ctx.arcTo(x, y + height, x, y, r);
        ctx.arcTo(x, y, x + width, y, r);
        ctx.closePath();
      }

      async function demoFile() {
        const card = document.createElement("canvas");
        card.width = 1400;
        card.height = 880;
        const ctx = card.getContext("2d");
        ctx.fillStyle = "#dce9ee";
        ctx.fillRect(0, 0, 1400, 880);
        ctx.fillStyle = "#c9dfe5";
        ctx.beginPath();
        ctx.arc(1160, 110, 330, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#eef5f5";
        ctx.beginPath();
        ctx.arc(1240, 770, 410, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#456a79";
        ctx.font = "700 76px Microsoft YaHei, sans-serif";
        ctx.fillText("演示证件", 90, 120);
        ctx.font = "500 28px Microsoft YaHei, sans-serif";
        ctx.fillText("DEMO DOCUMENT · 非真实证件", 92, 169);
        ctx.fillStyle = "#9bb6bf";
        ctx.beginPath();
        ctx.arc(285, 410, 118, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#819fa9";
        roundRect(ctx, 140, 530, 290, 190, 72);
        ctx.fill();
        ctx.fillStyle = "#34505d";
        ctx.font = "600 32px Microsoft YaHei, sans-serif";
        [["姓名", "示例用户"], ["用途", "界面功能演示"], ["编号", "DEMO 0000 0000"]].forEach((row, index) => {
          ctx.fillText(row[0], 520, 310 + index * 80);
          ctx.fillText(row[1], 650, 310 + index * 80);
        });
        ctx.fillStyle = "#bd3f32";
        ctx.font = "700 30px Microsoft YaHei, sans-serif";
        ctx.fillText("SAMPLE / 仅供演示", 520, 610);
        ctx.fillStyle = "#607780";
        ctx.font = "400 23px Microsoft YaHei, sans-serif";
        ctx.fillText("你可以调整左侧文字、颜色、透明度、角度与布局。", 520, 665);

        const photo = document.createElement("canvas");
        photo.width = 1800;
        photo.height = 1300;
        const photoCtx = photo.getContext("2d");
        const gradient = photoCtx.createLinearGradient(0, 0, 1800, 1300);
        gradient.addColorStop(0, "#77736b");
        gradient.addColorStop(1, "#4f554f");
        photoCtx.fillStyle = gradient;
        photoCtx.fillRect(0, 0, photo.width, photo.height);
        photoCtx.globalAlpha = .12;
        photoCtx.strokeStyle = "#ffffff";
        photoCtx.lineWidth = 3;
        for (let y = 70; y < photo.height; y += 74) {
          photoCtx.beginPath();
          photoCtx.moveTo(0, y);
          photoCtx.lineTo(photo.width, y - 35);
          photoCtx.stroke();
        }
        photoCtx.globalAlpha = 1;
        photoCtx.save();
        photoCtx.translate(900, 650);
        photoCtx.rotate(-4.5 * Math.PI / 180);
        photoCtx.shadowColor = "rgba(0, 0, 0, .48)";
        photoCtx.shadowBlur = 44;
        photoCtx.shadowOffsetY = 24;
        photoCtx.drawImage(card, -650, -409, 1300, 817);
        photoCtx.restore();

        const blob = await new Promise((resolve) => photo.toBlob(resolve, "image/png"));
        return new File([blob], "演示证件.png", { type: "image/png" });
      }

      function toBlob(canvas, type, quality) {
        return new Promise((resolve, reject) => {
          canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("生成失败")), type, quality);
        });
      }

      async function jpegToTarget(item, targetBytes) {
        const dimensions = sourceDimensions(itemSource(item));
        const originalMax = Math.max(dimensions.width, dimensions.height);
        let limit = originalMax;
        let fallback = null;

        for (let pass = 0; pass < 9; pass += 1) {
          const canvas = document.createElement("canvas");
          draw(canvas, item, limit);
          const low = await toBlob(canvas, "image/jpeg", .18);
          fallback = { blob: low, width: canvas.width, height: canvas.height };

          if (low.size > targetBytes && Math.min(canvas.width, canvas.height) > 220) {
            const ratio = Math.max(.45, Math.min(.9, Math.sqrt(targetBytes / low.size) * .94));
            limit = Math.max(260, Math.floor(Math.max(canvas.width, canvas.height) * ratio));
            continue;
          }

          let left = .18;
          let right = .95;
          let best = low;
          for (let attempt = 0; attempt < 9; attempt += 1) {
            const quality = (left + right) / 2;
            const candidate = await toBlob(canvas, "image/jpeg", quality);
            if (candidate.size <= targetBytes) {
              best = candidate;
              left = quality;
            } else {
              right = quality;
            }
          }
          return { blob: best, width: canvas.width, height: canvas.height };
        }
        return fallback;
      }

      function targetLabel() {
        if (state.targetBytes === 1048576) return "1MB";
        if (state.targetBytes === 512000) return "500KB";
        if (state.targetBytes === 102400) return "100KB";
        return "";
      }

      function download(blob, name) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }

      async function exportItem(item) {
        const previous = state.original;
        state.original = false;
        let result;
        try {
          if (state.format === "jpeg" && state.targetBytes > 0) {
            result = await jpegToTarget(item, state.targetBytes);
          } else {
            const canvas = document.createElement("canvas");
            draw(canvas, item, null);
            const type = state.format === "png" ? "image/png" : "image/jpeg";
            const blob = await toBlob(canvas, type, state.quality);
            result = { blob, width: canvas.width, height: canvas.height };
          }
        } finally {
          state.original = previous;
        }
        const base = item.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "-") || "证件";
        const correctionSuffix = item.corrected ? "-已矫正" : "";
        const sizeSuffix = state.format === "jpeg" && state.targetBytes ? `-${targetLabel()}` : "";
        const extension = state.format === "png" ? "png" : "jpg";
        download(result.blob, `${base}${correctionSuffix}-已加水印${sizeSuffix}.${extension}`);
        return { size: result.blob.size, width: result.width, height: result.height };
      }

      async function exporting(action) {
        if (state.busy) return;
        state.busy = true;
        update();
        try { await action(); }
        catch (error) {
          console.error(error);
          toast("导出失败，请缩小原图后重试");
        } finally {
          state.busy = false;
          el.exportLabel.textContent = "下载当前图片";
          update();
        }
      }

      el.choose.addEventListener("click", () => el.file.click());
      el.add.addEventListener("click", () => el.file.click());
      el.file.addEventListener("change", () => addFiles(el.file.files));
      el.demo.addEventListener("click", async () => addFiles([await demoFile()]));
      el.remove.addEventListener("click", remove);
      el.scanCurrent.addEventListener("click", openScan);
      el.restoreOriginal.addEventListener("click", restoreOriginal);
      el.scanClose.addEventListener("click", closeScan);
      el.scanCancel.addEventListener("click", closeScan);
      el.scanReset.addEventListener("click", () => state.scanEditor?.reset());
      el.scanApply.addEventListener("click", applyScan);
      el.scanDialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeScan();
      });
      el.scanDialog.addEventListener("click", (event) => {
        if (event.target === el.scanDialog) closeScan();
      });

      ["dragenter", "dragover"].forEach((name) => el.stage.addEventListener(name, (event) => {
        event.preventDefault();
        el.stage.classList.add("dragging");
      }));
      ["dragleave", "drop"].forEach((name) => el.stage.addEventListener(name, (event) => {
        event.preventDefault();
        el.stage.classList.remove("dragging");
      }));
      el.stage.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
      document.addEventListener("paste", (event) => {
        const files = Array.from(event.clipboardData?.files || []);
        if (files.some((file) => file.type.startsWith("image/"))) {
          event.preventDefault();
          addFiles(files);
        }
      });

      el.text.addEventListener("input", () => {
        el.count.textContent = el.text.value.length;
        schedule();
      });
      document.querySelectorAll(".chip").forEach((button) => button.addEventListener("click", () => {
        el.text.value = button.dataset.text;
        el.count.textContent = el.text.value.length;
        schedule();
      }));
      el.date.addEventListener("change", () => {
        state.date = el.date.checked;
        el.dateOptions.hidden = !state.date;
        schedule();
      });
      el.dateButtons.addEventListener("click", (event) => {
        const button = event.target.closest("[data-date-format]");
        if (!button) return;
        state.dateFormat = button.dataset.dateFormat;
        pressed(el.dateButtons, button);
        schedule();
      });

      el.layouts.addEventListener("click", (event) => {
        const button = event.target.closest("[data-layout]");
        if (!button) return;
        state.layout = button.dataset.layout;
        pressed(el.layouts, button);
        schedule();
      });

      el.colors.addEventListener("click", (event) => {
        const button = event.target.closest("[data-color]");
        if (!button) return;
        state.color = button.dataset.color;
        el.colorName.textContent = button.dataset.name;
        el.custom.value = state.color;
        pressed(el.colors, button);
        schedule();
      });
      el.custom.addEventListener("input", () => {
        state.color = el.custom.value;
        el.colorName.textContent = state.color.toUpperCase();
        el.colors.querySelectorAll("[aria-pressed]").forEach((button) => button.setAttribute("aria-pressed", "false"));
        schedule();
      });

      el.opacity.addEventListener("input", () => {
        state.opacity = Number(el.opacity.value) / 100;
        el.opacityOut.textContent = `${el.opacity.value}%`;
        schedule();
      });
      el.size.addEventListener("input", () => {
        state.size = Number(el.size.value);
        el.sizeOut.textContent = el.size.value;
        schedule();
      });
      el.space.addEventListener("input", () => {
        state.space = Number(el.space.value) / 100;
        el.spaceOut.textContent = state.space < .9 ? "紧密" : state.space > 1.35 ? "宽松" : "标准";
        schedule();
      });
      el.angle.addEventListener("input", () => {
        state.angle = Number(el.angle.value);
        el.angleOut.textContent = state.angle === 0 ? "0°" : `${state.angle < 0 ? "−" : "+"}${Math.abs(state.angle)}°`;
        schedule();
      });

      el.formats.addEventListener("click", (event) => {
        const button = event.target.closest("[data-format]");
        if (!button) return;
        state.format = button.dataset.format;
        pressed(el.formats, button);
        const isJpeg = state.format === "jpeg";
        el.jpgOptions.hidden = !isJpeg;
        el.qualityRow.hidden = !isJpeg || state.targetBytes > 0;
      });
      el.sizeButtons.addEventListener("click", (event) => {
        const button = event.target.closest("[data-target]");
        if (!button) return;
        state.targetBytes = Number(button.dataset.target);
        pressed(el.sizeButtons, button);
        el.qualityRow.hidden = state.targetBytes > 0;
      });
      el.quality.addEventListener("input", () => {
        state.quality = Number(el.quality.value) / 100;
        el.qualityOut.textContent = `${el.quality.value}%`;
      });

      const showOriginal = () => {
        if (!state.items.length) return;
        state.original = true;
        schedule();
      };
      const hideOriginal = () => {
        if (!state.original) return;
        state.original = false;
        schedule();
      };
      el.compare.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        showOriginal();
      });
      el.compare.addEventListener("pointerup", hideOriginal);
      el.compare.addEventListener("pointercancel", hideOriginal);
      el.compare.addEventListener("keydown", (event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          showOriginal();
        }
      });
      el.compare.addEventListener("keyup", hideOriginal);
      window.addEventListener("blur", hideOriginal);

      el.exportCurrent.addEventListener("click", () => exporting(async () => {
        const item = state.items[state.active];
        if (!item) return;
        el.exportLabel.textContent = "正在生成高清图片…";
        const result = await exportItem(item);
        toast(`已生成 ${bytes(result.size)} · ${result.width}×${result.height}`);
      }));
      el.exportAll.addEventListener("click", () => exporting(async () => {
        const results = [];
        for (const item of state.items) {
          results.push(await exportItem(item));
          await new Promise((resolve) => setTimeout(resolve, 160));
        }
        const largest = Math.max(...results.map((result) => result.size));
        toast(`已生成 ${state.items.length} 张 · 最大 ${bytes(largest)}`);
      }));

      window.addEventListener("beforeunload", () => {
        destroyScanEditor();
        state.items.forEach((item) => {
          releaseCorrected(item);
          URL.revokeObjectURL(item.url);
        });
      });

      el.count.textContent = el.text.value.length;
      update();
    })();
