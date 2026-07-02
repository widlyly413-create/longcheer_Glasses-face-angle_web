// @ts-nocheck
// cv.worker.ts
// ↑ 必须放在第一行，强行让 Vercel 编译器跳过严格类型检查

// ============================================================
// 1. 在 Web Worker 内部安全加载 OpenCV.js
// ============================================================
if (typeof cv === 'undefined') {
  try {
    // Vercel 线上环境优先使用绝对路径加载 public 目录下的依赖
    importScripts('/opencv.js');
  } catch (e) {
    console.warn("OpenCV.js 绝对路径加载失败，正在尝试相对路径...", e);
    try {
      // 本地或特定路由下的兜底方案
      importScripts('../opencv.js');
    } catch (err) {
      console.error("OpenCV 加载彻底失败，请确保 public 目录下有 opencv.js", err);
    }
  }
}

// ============================================================
// 2. 监听主线程消息
// ============================================================
self.onmessage = async (e: MessageEvent) => {
  const { imageSrc, userId } = e.data;
  
  try {
    // 确保 OpenCV 引擎已经完全异步挂载
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

    // 解析图像为像素数据
    const imgData = await fetchImageData(imageSrc);
    let rgba = cv.matFromImageData(imgData);
    let h = rgba.rows;
    let w = rgba.cols;
    
    // 【关键】将前端的 RGBA 转为 BGR 通道（匹配算法预期的通道顺序 b,g,r）
    let src = new cv.Mat();
    cv.cvtColor(rgba, src, cv.COLOR_RGBA2BGR);
    rgba.delete(); 
    
    // 动态视觉绘制参数（根据图像宽度自适应）
    const dynRadius = Math.max(5, Math.floor(w / 150));      
    const dynLine = Math.max(2, Math.floor(w / 500));        
    
    // 级联策略：先 V27（严格），失败则 V28（容错）
    const MIN_ANGLE = 168.0;
    const resultV27 = runV27(src, w, h, MIN_ANGLE);
    
    if (resultV27.success) {
      drawMetrics(src, resultV27.bestSet, resultV27.angle, dynLine, dynRadius, userId);
      sendResult(src, true, resultV27.angle, "V27", `成功（V27）`);
    } else {
      const resultV28 = runV28(src, w, h, MIN_ANGLE);
      if (resultV28.success) {
        drawMetrics(src, resultV28.bestSet, resultV28.angle, dynLine, dynRadius, userId);
        sendResult(src, true, resultV28.angle, "V28", `成功（V28）`);
      } else {
        sendResult(src, false, 0, "失败", "未组合出符合眼镜特征的骨架。请确保眼镜水平正对镜头，并重新拍照。");
      }
    }
    
    src.delete(); // 释放核心矩阵内存
    
  } catch (error) {
    console.error("Worker Error:", error);
    (self as any).postMessage({
      success: false,
      angle: 0,
      version: "错误",
      msg: "图像解析异常或内部崩溃，请尝试重新拍照。"
    });
  }
};

// ============================================================
// 3. 零拷贝传输回主线程
// ============================================================
function sendResult(src: any, success: boolean, angle: number, version: string, msg: string) {
  const dstImgData = matToImageData(src);
  // 利用 Transferable Objects（dstImgData.data.buffer）极速传回，不卡顿手机
  (self as any).postMessage({
    success,
    angle,
    version,
    msg,
    rgbaData: dstImgData.data,
    width: dstImgData.width,
    height: dstImgData.height
  }, [dstImgData.data.buffer]);
}

// ============================================================
// 4. V27 算法（严格模式）
// ============================================================
function runV27(src: any, w: number, h: number, minAngle: number) {
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
    balanceErrFilter: 0.15, // V27 拥有严格的平衡误差过滤
    topN: 12
  });
  
  b.delete(); g.delete(); r.delete(); bgrPlanes.delete();
  rgDiff.delete(); rbDiff.delete();
  
  return result;
}

// ============================================================
// 5. V28 算法（容错模式）
// ============================================================
function runV28(src: any, w: number, h: number, minAngle: number) {
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
  cv.cvtColor(src, hsv, cv.COLOR_BGR2HSV);
  
  const cascadeThresholds = [
    // RGB 容错层
    { mode: "rgb", rg: 75, rb: 45, r: 120, circ: 0.55, areaMin: 12 },
    { mode: "rgb", rg: 55, rb: 40, r: 100, circ: 0.40, areaMin: 8  },
    { mode: "rgb", rg: 40, rb: 30, r: 80,  circ: 0.25, areaMin: 5  },
    // HSV 极端光照兜底层
    { mode: "hsv", hLow: 0,   hHigh: 10,  sLow: 30, vLow: 60, circ: 0.20, areaMin: 3 },
    { mode: "hsv", hLow: 165, hHigh: 180, sLow: 30, vLow: 60, circ: 0.20, areaMin: 3 }
  ];
  
  const result = runCascadePassesV28(src, w, h, minAngle, cascadeThresholds, rgDiff, rbDiff, r, hsv);
  
  b.delete(); g.delete(); r.delete(); bgrPlanes.delete();
  rgDiff.delete(); rbDiff.delete(); hsv.delete();
  
  return result;
}

// ============================================================
// 6. V28 级联核心执行器
// ============================================================
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

// ============================================================
// 7. V27 级联核心执行器
// ============================================================
function runCascadePasses(
  src: any, w: number, h: number, minAngle: number,
  thresholds: any[], mode: string,
  opts: { areaMax: number, morphSize: number, errorThreshold: number, balanceErrFilter?: number, topN: number }
) {
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
    
    let kernelClose = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(opts.morphSize, opts.morphSize));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernelClose);
    kernelClose.delete();
    
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

// ============================================================
// 8. 辅助绘制工具：画线、画点、写文字
// ============================================================
function drawMetrics(src: any, bestSet: any[], angle: number, dynLine: number, dynRadius: number, userId?: string) {
  let p1 = new cv.Point(bestSet[0].cX, bestSet[0].cY);
  let p_mid = new cv.Point(bestSet[1].cX, bestSet[1].cY);
  let p2 = new cv.Point(bestSet[2].cX, bestSet[2].cY);
  
  // 画橙色辅助线
  cv.line(src, p1, p_mid, [255, 120, 0, 255], dynLine, cv.LINE_AA);
  cv.line(src, p_mid, p2, [255, 120, 0, 255], dynLine, cv.LINE_AA);
  
  // 画特征点靶心
  for (let p of [p1, p_mid, p2]) {
    cv.circle(src, p, dynRadius, [0, 255, 255, 255], -1, cv.LINE_AA);
    cv.circle(src, p, dynRadius, [0, 0, 0, 255], 1, cv.LINE_AA);
  }
  
  const h = src.rows;
  const w = src.cols;
  const fontSize = Math.max(1.0, w / 550);     
  const fontThick = Math.max(2, Math.floor(w / 400));  
  
  const offsetX = Math.floor(w * 0.03);
  const offsetY = -Math.floor(h * 0.04);
  let textX = p_mid.x + offsetX;
  let textY = p_mid.y + offsetY;
  textX = Math.max(Math.floor(w * 0.02), Math.min(textX, Math.floor(w * 0.7)));
  textY = Math.max(Math.floor(h * 0.12), Math.min(textY, Math.floor(h * 0.88)));
  
  const lineHeight = Math.floor(fontSize * 28);  
  
  // 绘制用户编号（如果传入了）
  if (userId) {
    const idText = `ID: ${userId}`;
    cv.putText(src, idText, new cv.Point(textX, textY - lineHeight), cv.FONT_HERSHEY_SIMPLEX, fontSize, [0, 0, 0, 255], fontThick + 3, cv.LINE_AA);
    cv.putText(src, idText, new cv.Point(textX, textY - lineHeight), cv.FONT_HERSHEY_SIMPLEX, fontSize, [255, 255, 255, 255], fontThick, cv.LINE_AA);
  }
  
  // 绘制角度值
  const angleText = `${angle.toFixed(2)}`;
  cv.putText(src, angleText, new cv.Point(textX, textY), cv.FONT_HERSHEY_SIMPLEX, fontSize, [0, 0, 0, 255], fontThick + 3, cv.LINE_AA);
  cv.putText(src, angleText, new cv.Point(textX, textY), cv.FONT_HERSHEY_SIMPLEX, fontSize, [0, 255, 255, 255], fontThick, cv.LINE_AA);
}

// ============================================================
// 9. 内存与像素格式转换工具
// ============================================================
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
  // 算法处理完的 src 是 BGR（3通道），必须转为 RGBA（4通道）才能在前端 Canvas 画出来
  let rgb = new cv.Mat();
  cv.cvtColor(mat, rgb, cv.COLOR_BGR2RGB);
  
  let rgba = new cv.Mat(rgb.rows, rgb.cols, cv.CV_8UC4);
  let planes = new cv.MatVector();
  cv.split(rgb, planes);
  
  let alpha = new cv.Mat(rgb.rows, rgb.cols, cv.CV_8UC1, new cv.Scalar(255));
  planes.push_back(alpha);
  cv.merge(planes, rgba);
  
  let imgData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  
  // 严谨释放每一滴内存，防止爆栈
  rgb.delete(); rgba.delete(); alpha.delete();
  for (let i = 0; i < planes.size(); i++) planes.get(i).delete();
  planes.delete();
  
  return imgData;
}