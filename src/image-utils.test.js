import { describe, expect, it } from "vitest";
import {
  correctedFileName,
  cornerCoverage,
  defaultCorners,
  fitDimensions,
  reliableDetection,
  sourceDimensions
} from "./image-utils.js";

describe("fitDimensions", () => {
  it("keeps images already below the scan limit", () => {
    expect(fitDimensions(1600, 1000, 4096)).toEqual({ width: 1600, height: 1000, scale: 1 });
  });

  it("downscales large phone photos without changing their aspect ratio", () => {
    expect(fitDimensions(8000, 6000, 4096)).toEqual({
      width: 4096,
      height: 3072,
      scale: 0.512
    });
  });
});

describe("sourceDimensions", () => {
  it("prefers natural image dimensions", () => {
    expect(sourceDimensions({ naturalWidth: 3024, naturalHeight: 1964, width: 100, height: 50 }))
      .toEqual({ width: 3024, height: 1964 });
  });

  it("rejects empty sources", () => {
    expect(() => sourceDimensions({ width: 0, height: 0 })).toThrow("无法读取图片尺寸");
  });
});

describe("defaultCorners", () => {
  it("creates a safe inset quadrilateral", () => {
    expect(defaultCorners({ width: 1000, height: 600 }, 0.05)).toEqual({
      topLeft: { x: 50, y: 30 },
      topRight: { x: 950, y: 30 },
      bottomRight: { x: 950, y: 570 },
      bottomLeft: { x: 50, y: 570 }
    });
  });
});

describe("detection validation", () => {
  const source = { width: 1000, height: 600 };
  const documentCorners = {
    topLeft: { x: 100, y: 100 },
    topRight: { x: 900, y: 100 },
    bottomRight: { x: 900, y: 500 },
    bottomLeft: { x: 100, y: 500 }
  };

  it("measures the detected quadrilateral against the source image", () => {
    expect(cornerCoverage(documentCorners, source)).toBeCloseTo(0.5333, 3);
  });

  it("accepts a confident, substantial document detection", () => {
    expect(reliableDetection({
      success: true,
      confidence: 0.71,
      corners: documentCorners
    }, source)).toBe(true);
  });

  it("rejects low-confidence false positives", () => {
    expect(reliableDetection({
      success: true,
      confidence: 0.17,
      corners: documentCorners
    }, source)).toBe(false);
  });
});

describe("correctedFileName", () => {
  it("removes the original extension", () => {
    expect(correctedFileName("身份证正面.jpeg")).toBe("身份证正面-已矫正");
  });
});
