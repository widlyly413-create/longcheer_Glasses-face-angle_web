// cv.worker.ts
// 在 Web Worker 环境中加载 OpenCV.js（Worker 是独立线程，无法访问主线程全局变量）
importScripts(new URL('/opencv.js', (self as any).location?.href || '/').href);

declare var cv: any;

// 监听主线程发送的图片数据
self.onmessage = async (e: MessageEvent) => {
  const { imageSrc, userId } = e.data;
  
  try {
    // 1. 等待 OpenCV 初始化完成
    if (typeof cv === 'undefined' || !cv.Mat) {
      await new Promise<void>((resolve) => {
        const checkReady = () => {
          if (typeof cv !== 'undefined' && cv.Mat) {
            resolve();
          } else {
            setTimeout(checkReady, 100);
          }
        };
        checkReady();
      });
    }

    // 2. 将前端传入的图片 URL 转为 ImageData 并载入成 OpenCV 的 Mat 矩阵
    const imgData = await fetchImageData(imageSrc);
    let rgba = cv.matFromImageData(imgData);
    let h = rgba.rows;
    let w = rgba.cols;
    
    // 【关键修复】将 RGBA 转为 BGR，与 Python cv2.imread 的 BGR 格式一致
    // 这样后续 cv.split 得到的顺序就是 B=0, G=1, R=2
    let src = new cv.Mat();
    cv.cvtColor(rgba, src, cv.COLOR_RGBA2BGR);
    rgba.delete(); // 释放 RGBA 矩阵
    
    // 3. 根据手机屏幕分辨率动态计算人因工程制图参数
    const dynRadius = Math.max(5, Math.floor(w / 150));      
    const dynLine = Math.max(2, Math.floor(w / 500));        
    
    // 4. 执行级联策略：先 V27（严格），失败则 V28（容错）
    const MIN_ANGLE = 168.0;
    
    // 先尝试 V27
    const resultV27 = runV27(src, w, h, MIN_ANGLE);
    
    if (resultV27.success) {
      drawMetrics(src, resultV27.bestSet, resultV27.angle, dynLine, dynRadius, userId);
      sendResult(src, true, resultV27.angle, "V27", `成功（V27）`);
    } else {
      // V27 失败，尝试 V28
      const resultV28 = runV28(src, w, h, MIN_ANGLE);
      
      if (resultV28.success) {
        drawMetrics(src, resultV28.bestSet, resultV28.angle, dynLine, dynRadius, userId);
        sendResult(src, true, resultV28.angle, "V28", `成功（V28）`);
      } else {
        sendResult(src, false, 0, "失败", "未组合出符合眼镜特征的骨架。请确保眼镜水平正对镜头，并重新拍照。");
      }
    }
    
    src.delete();
    
  } catch (error) {
    self.postMessage({
      success: false,
      angle: 0,
      version: "错误",
      msg: "图像解析异常，请尝试重新拍照。"
    });
  }
};

function sendResult(src: any, success: boolean, angle: number, version: string, msg: string) {
  const dstImgData = matToImageData(src);
  self.postMessage({
    success,
    angle,
    version,
    msg,
    rgbaData: dstImgData.data,
    width: dstImgData.width,
    height: dstImgData.height
  }, [dstImgData.data.buffer as ArrayBuffer]);
}

// ================= V27 算法（严格模式） =================
// 对应 Python process_image_v27: 3 层 RGB 阈值 + balance_err > 0.15 过滤
function runV27(src: any, w: number, h: number, minAngle: number) {
  // 分离 BGR 通道
  let bgrPlanes = new cv.MatVector();
  cv.split(src, bgrPlanes);
  let b = bgrPlanes.get(0);
  let g = bgrPlanes.get(1);
  let r = bgrPlanes.get(2);
  
  let rgDiff = new cv.Mat();
  let rbDiff = new cv.Mat();
  cv.subtract(r, g, rgDiff);
  cv.subtract(r, b, rbDiff);
  
  const cascadeThresholds = [
    { rg: 75, rb: 45, r: 120, circ: 0.55, areaMin: 12 },
    { rg: 55, rb: 40, r: 100, circ: 0.45, areaMin: 10 },
    { rg: 40, rb: 30, r: 80,  circ: 0.35, areaMin: 8  }
  ];
  
  const result = runCascadePasses(src, w, h, minAngle, cascadeThresholds, "rgb", {
    areaMax: 2000,
    morphSize: 5,
    errorThreshold: 0.03,
    balanceErrFilter: 0.15,   // V27 有平衡误差过滤
    topN: 12
  });
  
  b.delete(); g.delete(); r.delete(); bgrPlanes.delete();
  rgDiff.delete(); rbDiff.delete();
  
  return result;
}

// ================= V28 算法（容错模式） =================
// 对应 Python process_image_v28: 3 层 RGB + 2 层 HSV，无 balance_err 过滤
function runV28(src: any, w: number, h: number, minAngle: number) {
  // 分离 BGR 通道
  let bgrPlanes = new cv.MatVector();
  cv.split(src, bgrPlanes);
  let b = bgrPlanes.get(0);
  let g = bgrPlanes.get(1);
  let r = bgrPlanes.get(2);
  
  let rgDiff = new cv.Mat();
  let rbDiff = new cv.Mat();
  cv.subtract(r, g, rgDiff);
  cv.subtract(r, b, rbDiff);
  
  // HSV 颜色空间（V28 后两层使用）—— src 是 BGR 格式
  let hsv = new cv.Mat();
  cv.cvtColor(src, hsv, cv.COLOR_BGR2HSV);
  
  const cascadeThresholds = [
    // 3 层 RGB（阈值比 V27 宽松）
    { mode: "rgb", rg: 75, rb: 45, r: 120, circ: 0.55, areaMin: 12 },
    { mode: "rgb", rg: 55, rb: 40, r: 100, circ: 0.40, areaMin: 8  },
    { mode: "rgb", rg: 40, rb: 30, r: 80,  circ: 0.25, areaMin: 5  },
    // 2 层 HSV 容错
    { mode: "hsv", hLow: 0,   hHigh: 10,  sLow: 30, vLow: 60, circ: 0.20, areaMin: 3 },
    { mode: "hsv", hLow: 165, hHigh: 180, sLow: 30, vLow: 60, circ: 0.20, areaMin: 3 }
  ];
  
  const result = runCascadePassesV28(src, w, h, minAngle, cascadeThresholds, rgDiff, rbDiff, r, hsv);
  
  b.delete(); g.delete(); r.delete(); bgrPlanes.delete();
  rgDiff.delete(); rbDiff.delete(); hsv.delete();
  
  return result;
}

// ================= V28 级联执行（不传递 balanceErrFilter，RGB 无平衡误差过滤） =================
function runCascadePassesV28(
  src: any, w: number, h: number, minAngle: number,
  thresholds: any[], rgDiff: any, rbDiff: any, r: any, hsv: any
) {
  let bestSet: any = null;
  let minGeometricError = Infinity;
  let finalAngle = 0;

  for (let th of thresholds) {
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
    
    // 形态学处理
    let ksize = th.mode === "rgb" ? new cv.Size(5, 5) : new cv.Size(7, 7);
    let kernelClose = cv.getStructuringElement(cv.MORPH_ELLIPSE, ksize);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernelClose);
    kernelClose.delete();
    
    // HSV 层追加膨胀
    if (th.mode === "hsv") {
      let kernelDilate = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
      cv.dilate(mask, mask, kernelDilate, new cv.Point(-1, -1), 1);
      kernelDilate.delete();
    }
    
    // 提取轮廓
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
            
            // 【关键】V28 的 RGB 层没有 balanceErr > 0.15 过滤
            // 与 Python V28 完全一致：直接用 balanceErr 和 minGeometricError 比较
            if (balanceErr < minGeometricError && angle >= minAngle) {
              minGeometricError = balanceErr;
              bestSet = [p1, p_mid, p2];
              finalAngle = angle;
            }
          }
        }
      }
    }
    
    mask.delete(); contours.delete(); hierarchy.delete();
    if (bestSet) break;
  }
  
  return { success: bestSet !== null, bestSet, angle: finalAngle };
}

// ================= 通用级联执行（用于 V27） =================
function runCascadePasses(
  src: any, w: number, h: number, minAngle: number,
  thresholds: any[], mode: string,
  opts: { areaMax: number, morphSize: number, errorThreshold: number, balanceErrFilter?: number, topN: number }
) {
  // 重新获取通道和差值（因为 V27 和 V28 独立运行，src 是原始图像）
  let bgrPlanes = new cv.MatVector();
  cv.split(src, bgrPlanes);
  let b = bgrPlanes.get(0);
  let g = bgrPlanes.get(1);
  let r = bgrPlanes.get(2);
  
  let rgDiff = new cv.Mat();
  let rbDiff = new cv.Mat();
  cv.subtract(r, g, rgDiff);
  cv.subtract(r, b, rbDiff);

  let bestSet: any = null;
  let minGeometricError = Infinity;
  let finalAngle = 0;

  for (let th of thresholds) {
    let mask = new cv.Mat();
    
    let mask1 = new cv.Mat();
    let mask2 = new cv.Mat();
    let mask3 = new cv.Mat();
    cv.threshold(rgDiff, mask1, th.rg, 255, cv.THRESH_BINARY);
    cv.threshold(rbDiff, mask2, th.rb, 255, cv.THRESH_BINARY);
    cv.threshold(r, mask3, th.r, 255, cv.THRESH_BINARY);
    cv.bitwise_and(mask1, mask2, mask);
    cv.bitwise_and(mask, mask3, mask);
    mask1.delete(); mask2.delete(); mask3.delete();
    
    // 形态学处理
    let kernelClose = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(opts.morphSize, opts.morphSize));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernelClose);
    kernelClose.delete();
    
    // 提取轮廓
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    
    let candidates: Array<{ cX: number, cY: number, area: number }> = [];
    
    for (let i = 0; i < contours.size(); ++i) {
      let cnt = contours.get(i);
      let area = cv.contourArea(cnt);
      
      if (area > th.areaMin && area < opts.areaMax) {
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
    let pts = candidates.slice(0, opts.topN);
    
    if (pts.length >= 3) {
      for (let i = 0; i < pts.length - 2; i++) {
        if (minGeometricError < opts.errorThreshold) break;
        for (let j = i + 1; j < pts.length - 1; j++) {
          if (minGeometricError < opts.errorThreshold) break;
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
            
            // V27 的 balanceErr 过滤
            if (opts.balanceErrFilter !== undefined && balanceErr > opts.balanceErrFilter) continue;
            
            if (balanceErr < minGeometricError && angle >= minAngle) {
              minGeometricError = balanceErr;
              bestSet = [p1, p_mid, p2];
              finalAngle = angle;
            }
          }
        }
      }
    }
    
    mask.delete(); contours.delete(); hierarchy.delete();
    if (bestSet) break;
  }
  
  b.delete(); g.delete(); r.delete(); bgrPlanes.delete();
  rgDiff.delete(); rbDiff.delete();
  
  return { success: bestSet !== null, bestSet, angle: finalAngle };
}

// ================= 辅助可视化绘制 =================
function drawMetrics(src: any, bestSet: any[], angle: number, dynLine: number, dynRadius: number, userId?: string) {
  // 骨架线绘制
  let p1 = new cv.Point(bestSet[0].cX, bestSet[0].cY);
  let p_mid = new cv.Point(bestSet[1].cX, bestSet[1].cY);
  let p2 = new cv.Point(bestSet[2].cX, bestSet[2].cY);
  
  cv.line(src, p1, p_mid, [255, 120, 0, 255], dynLine, cv.LINE_AA);
  cv.line(src, p_mid, p2, [255, 120, 0, 255], dynLine, cv.LINE_AA);
  
  for (let p of [p1, p_mid, p2]) {
    cv.circle(src, p, dynRadius, [0, 255, 255, 255], -1, cv.LINE_AA);
    cv.circle(src, p, dynRadius, [0, 0, 0, 255], 1, cv.LINE_AA);
  }
  
  // 动态计算字体大小和厚度（基于图像宽度，确保 CSS 缩放后仍可读）
  const h = src.rows;
  const w = src.cols;
  const fontSize = Math.max(1.0, w / 550);     // 1200px 图 → ~2.2
  const fontThick = Math.max(2, Math.floor(w / 400));  // 1200px 图 → 3
  
  // 【需求】在中间点 p_mid 附近绘制角度值（仅数字，无符号）
  // 相对于 p_mid 的偏移量（向右上方偏移）
  const offsetX = Math.floor(w * 0.03);
  const offsetY = -Math.floor(h * 0.04);
  // 确保不超出图像边界
  let textX = p_mid.x + offsetX;
  let textY = p_mid.y + offsetY;
  textX = Math.max(Math.floor(w * 0.02), Math.min(textX, Math.floor(w * 0.7)));
  textY = Math.max(Math.floor(h * 0.12), Math.min(textY, Math.floor(h * 0.88)));
  
  const lineHeight = Math.floor(fontSize * 28);  // 行高（像素）
  
  // 如果存在用户编号，在角度上方绘制（白色）
  if (userId) {
    const idText = `ID: ${userId}`;
    // 黑色描边
    cv.putText(src, idText, new cv.Point(textX, textY - lineHeight), cv.FONT_HERSHEY_SIMPLEX, fontSize, [0, 0, 0, 255], fontThick + 3, cv.LINE_AA);
    // 白色文字
    cv.putText(src, idText, new cv.Point(textX, textY - lineHeight), cv.FONT_HERSHEY_SIMPLEX, fontSize, [255, 255, 255, 255], fontThick, cv.LINE_AA);
  }
  
  // 角度值（黄色）
  const angleText = `${angle.toFixed(2)}`;
  // 黑色描边
  cv.putText(src, angleText, new cv.Point(textX, textY), cv.FONT_HERSHEY_SIMPLEX, fontSize, [0, 0, 0, 255], fontThick + 3, cv.LINE_AA);
  // 黄色主文字（醒目）
  cv.putText(src, angleText, new cv.Point(textX, textY), cv.FONT_HERSHEY_SIMPLEX, fontSize, [0, 255, 255, 255], fontThick, cv.LINE_AA);
}

// ================= 数据类型互转工具函数 =================
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
  // src 现在是 BGR（3 通道），需要转成 RGBA（4 通道）供前端显示
  let rgb = new cv.Mat();
  cv.cvtColor(mat, rgb, cv.COLOR_BGR2RGB);
  // 补充 Alpha 通道（全不透明）
  let rgba = new cv.Mat(rgb.rows, rgb.cols, cv.CV_8UC4);
  let planes = new cv.MatVector();
  cv.split(rgb, planes);
  let alpha = new cv.Mat(rgb.rows, rgb.cols, cv.CV_8UC1, new cv.Scalar(255));
  planes.push_back(alpha);
  cv.merge(planes, rgba);
  let imgData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  rgb.delete(); rgba.delete(); alpha.delete();
  for (let i = 0; i < planes.size(); i++) planes.get(i).delete();
  planes.delete();
  return imgData;
}