// @ts-nocheck
// ↑ 必须放在第一行！强行让 Vercel 编译器闭嘴，跳过对 Worker 内部复杂 OpenCV 类型的刁难

declare var cv: any;

self.onmessage = async (e: MessageEvent) => {
  const { imageSrc } = e.data;
  
  try {
    const imgData = await fetchImageData(imageSrc);
    let src = cv.matFromImageData(imgData);
    let h = src.rows;
    let w = src.cols;
    
    const dynRadius = Math.max(5, Math.floor(w / 150));      
    const dynLine = Math.max(2, Math.floor(w / 500));        
    
    const MIN_ANGLE = 168.0; 
    const result = runCascadeV27V28(src, w, h, MIN_ANGLE);
    
    if (result.success && result.bestSet) {
      drawMetrics(src, result.bestSet, dynLine, dynRadius);
      const dstImgData = matToImageData(src);
      
      // 使用最兼容的传输方式，绕过一切类型重载冲突
      (self as any).postMessage({
        success: true,
        angle: result.angle,
        version: result.version,
        msg: `成功（算法: ${result.version}）`,
        rgbaData: dstImgData.data, 
        width: dstImgData.width,
        height: dstImgData.height
      });
    } else {
      (self as any).postMessage({
        success: false,
        angle: 0,
        version: "失败",
        msg: "未组合出符合眼镜特征的骨架。请确保眼镜水平正对镜头，并重新拍照。"
      });
    }
    
    src.delete();
  } catch (error) {
    (self as any).postMessage({
      success: false,
      angle: 0,
      version: "错误",
      msg: "图像解析异常，请尝试重新拍照。"
    });
  }
};

function runCascadeV27V28(src: any, w: number, h: number, minAngle: number) {
  let bgrPlanes = new cv.MatVector();
  cv.split(src, bgrPlanes);
  let b = bgrPlanes.get(0);
  let g = bgrPlanes.get(1);
  let r = bgrPlanes.get(2);
  
  let rgDiff = new cv.Mat();
  let rbDiff = new cv.Mat();
  cv.subtract(r, g, rgDiff);
  cv.subtract(r, b, rbDiff);
  
  let hsv = new cv.Mat();
  cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB); 
  cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

  const cascadeThresholds = [
    { mode: "rgb", rg: 75, rb: 45, r: 120, circ: 0.55, areaMin: 12, version: "V27 (Pass 1)" },
    { mode: "rgb", rg: 55, rb: 40, r: 100, circ: 0.45, areaMin: 10, version: "V27 (Pass 2)" },
    { mode: "rgb", rg: 40, rb: 30, r: 80,  circ: 0.35, areaMin: 8,  version: "V27 (Pass 3)" },
    { mode: "hsv", hLow: 0,   hHigh: 10,  sLow: 30, vLow: 60, circ: 0.20, areaMin: 3, version: "V28 (HSV-1)" },
    { mode: "hsv", hLow: 165, hHigh: 180, sLow: 30, vLow: 60, circ: 0.20, areaMin: 3, version: "V28 (HSV-2)" }
  ];
  
  let bestSet: any = null;
  let minGeometricError = Infinity;
  let finalAngle = 0;
  let matchedVersion = "无";

  for (let th of cascadeThresholds) {
    let mask = new cv.Mat();
    
    if (th.mode === "rgb") {
      let mask1 = new cv.Mat();
      let mask2 = new cv.Mat();
      let mask3 = new cv.Mat();
      cv.threshold(rgDiff, mask1, th.rg, 255, cv.THRESH_BINARY);
      cv.threshold(rbDiff, mask2, th.rb, 255, cv.THRESH_BINARY);
      cv.threshold(r, mask3, th.r, 255, cv.THRESH_BINARY);
      
      cv.bitwise_and(mask1, mask2, mask);
      cv.bitwise_and(mask, mask3, mask);
      
      mask1.delete(); mask2.delete(); mask3.delete();
    } else {
      let lowBound = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [th.hLow, th.sLow, th.vLow, 0]);
      let highBound = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [th.hHigh, 255, 255, 255]);
      cv.inRange(hsv, lowBound, highBound, mask);
      lowBound.delete(); highBound.delete();
    }
    
    let ksize = th.mode === "rgb" ? new cv.Size(5, 5) : new cv.Size(7, 7);
    let kernelClose = cv.getStructuringElement(cv.MORPH_ELLIPSE, ksize);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernelClose);
    kernelClose.delete();
    
    if (th.mode === "hsv") {
      let kernelDilate = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
      cv.dilate(mask, mask, kernelDilate, new cv.Point(-1, -1), 1);
      kernelDilate.delete();
    }
    
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    
    let candidates: Array<{ cX: number, cY: number, area: number }> = [];
    const areaMax = th.mode === "rgb" ? 2000 : 3000;
    
    for (let i = 0; i < contours.size(); ++i) {
      let cnt = contours.get(i);
      let area = cv.contourArea(cnt);
      
      if (area > th.areaMin && area < areaMax) {
        let perimeter = cv.arcLength(cnt, true);
        if (perimeter === 0) continue;
        let circularity = (4 * Math.PI * area) / (perimeter * perimeter);
        
        if (circularity >= th.circ) {
          let M = cv.moments(cnt);
          if (M.m00 !== 0) {
            let cX = Math.floor(M.m10 / M.m00);
            let cY = Math.floor(M.m01 / M.m00);
            
            if (0.02 * w < cX && cX < 0.98 * w && 0.02 * h < cY && cY < 0.98 * h) {
              candidates.push({ cX, cY, area });
            }
          }
        }
      }
    }
    
    candidates.sort((a, b) => b.area - a.area);
    let pts = th.mode === "rgb" ? candidates.slice(0, 12) : candidates.slice(0, 15);
    
    if (pts.length >= 3) {
      const errorThreshold = th.mode === "rgb" ? 0.03 : 0.02; 
      
      for (let i = 0; i < pts.length - 2; i++) {
        if (minGeometricError < errorThreshold) break;
        for (let j = i + 1; j < pts.length - 1; j++) {
          if (minGeometricError < errorThreshold) break;
          for (let k = j + 1; k < pts.length; k++) {
            let pA = pts[i], pB = pts[j], pC = pts[k];
            
            let dAB = Math.hypot(pA.cX - pB.cX, pA.cY - pB.cY);
            let dBC = Math.hypot(pB.cX - pC.cX, pB.cY - pC.cY);
            let dCA = Math.hypot(pC.cX - pA.cX, pC.cY - pA.cY);
            
            let dists = [dAB, dBC, dCA];
            let maxDist = Math.max(...dists);
            
            if (maxDist < Math.min(w, h) * 0.30) continue;
            
            let p_mid, p1, p2;
            if (maxDist === dAB) { p_mid = pC; p1 = pA; p2 = pB; }
            else if (maxDist === dBC) { p_mid = pA; p1 = pB; p2 = pC; }
            else { p_mid = pB; p1 = pA; p2 = pC; }
            
            let v1 = { x: p1.cX - p_mid.cX, y: p1.cY - p_mid.cY };
            let v2 = { x: p2.cX - p_mid.cX, y: p2.cY - p_mid.cY };
            
            let dot = v1.x * v2.x + v1.y * v2.y;
            let len1 = Math.hypot(v1.x, v1.y);
            let len2 = Math.hypot(v2.x, v2.y);
            let cosTheta = dot / (len1 * len2);
            let angle = (Math.acos(Math.min(Math.max(cosTheta, -1.0), 1.0)) * 180) / Math.PI;
            
            if (angle < 160 || angle > 180) continue;
            
            let balanceErr = Math.abs(len1 - len2) / Math.max(len1, len2, 1);
            if (th.mode === "rgb" && balanceErr > 0.15) continue; 
            
            if (balanceErr < minGeometricError && angle >= minAngle) {
              minGeometricError = balanceErr;
              bestSet = [p1, p_mid, p2];
              finalAngle = angle;
              matchedVersion = th.version.includes("V27") ? "V27" : "V28";
            }
          }
        }
      }
    }
    
    mask.delete(); contours.delete(); hierarchy.delete();
    if (bestSet) break;
  }
  
  b.delete(); g.delete(); r.delete(); bgrPlanes.delete();
  rgDiff.delete(); rbDiff.delete(); hsv.delete();

  return { success: bestSet !== null, bestSet, angle: finalAngle, version: matchedVersion };
}

function drawMetrics(src: any, bestSet: any[], dynLine: number, dynRadius: number) {
  let p1 = new cv.Point(bestSet[0].cX, bestSet[0].cY);
  let p_mid = new cv.Point(bestSet[1].cX, bestSet[1].cY);
  let p2 = new cv.Point(bestSet[2].cX, bestSet[2].cY);
  
  cv.line(src, p1, p_mid, [255, 120, 0, 255], dynLine, cv.LINE_AA);
  cv.line(src, p_mid, p2, [255, 120, 0, 255], dynLine, cv.LINE_AA);
  
  for (let p of [p1, p_mid, p2]) {
    cv.circle(src, p, dynRadius, [0, 255, 255, 255], -1, cv.LINE_AA);
    cv.circle(src, p, dynRadius, [0, 0, 0, 255], 1, cv.LINE_AA);
  }
}

async function fetchImageData(url: string): Promise<ImageData> {
  const response = await fetch(url);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx?.drawImage(bitmap, 0, 0);
  return ctx!.getImageData(0, 0, bitmap.width, bitmap.height);
}

function matToImageData(mat: any): ImageData {
  let img = new cv.Mat();
  cv.cvtColor(mat, img, cv.COLOR_BGRA2RGBA);
  let imgData = new ImageData(new Uint8ClampedArray(img.data), img.cols, img.rows);
  img.delete();
  return imgData;
}
