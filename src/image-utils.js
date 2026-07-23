export const MAX_SCAN_DIMENSION = 4096;

export function sourceDimensions(source) {
  const width = source.naturalWidth || source.videoWidth || source.width;
  const height = source.naturalHeight || source.videoHeight || source.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new TypeError("无法读取图片尺寸");
  }
  return { width, height };
}

export function fitDimensions(width, height, maxDimension = MAX_SCAN_DIMENSION) {
  if (width <= maxDimension && height <= maxDimension) return { width, height, scale: 1 };
  const scale = maxDimension / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale
  };
}

export function createScanSource(source, maxDimension = MAX_SCAN_DIMENSION) {
  const original = sourceDimensions(source);
  const fitted = fitDimensions(original.width, original.height, maxDimension);
  if (fitted.scale === 1 && (source instanceof HTMLCanvasElement || source instanceof HTMLImageElement)) {
    return source;
  }
  const canvas = document.createElement("canvas");
  canvas.width = fitted.width;
  canvas.height = fitted.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, fitted.width, fitted.height);
  return canvas;
}

export function defaultCorners(source, insetRatio = 0.04) {
  const { width, height } = sourceDimensions(source);
  const insetX = Math.round(width * insetRatio);
  const insetY = Math.round(height * insetRatio);
  return {
    topLeft: { x: insetX, y: insetY },
    topRight: { x: width - insetX, y: insetY },
    bottomRight: { x: width - insetX, y: height - insetY },
    bottomLeft: { x: insetX, y: height - insetY }
  };
}

export function cornerCoverage(corners, source) {
  if (!corners) return 0;
  const points = [
    corners.topLeft,
    corners.topRight,
    corners.bottomRight,
    corners.bottomLeft
  ];
  if (points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) return 0;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  const { width, height } = sourceDimensions(source);
  return Math.abs(twiceArea) / 2 / (width * height);
}

export function reliableDetection(result, source, options = {}) {
  const minConfidence = options.minConfidence ?? 0.35;
  const minCoverage = options.minCoverage ?? 0.08;
  return Boolean(
    result?.success
    && result.corners
    && Number.isFinite(result.confidence)
    && result.confidence >= minConfidence
    && cornerCoverage(result.corners, source) >= minCoverage
  );
}

export function correctedFileName(name) {
  const base = String(name || "证件").replace(/\.[^.]+$/, "");
  return `${base}-已矫正`;
}
