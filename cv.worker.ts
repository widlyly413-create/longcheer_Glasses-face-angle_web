// cv.worker.ts
// 在 Web Worker 环境中加载 OpenCV.js（Worker 是独立线程，无法访问主线程全局变量）
importScripts('https://docs.opencv.org/4.7.0/opencv.js');

declare var cv: any;

// 监听主线程发送的图片数据
self.onmessage = async (e: MessageEvent) => {
  const { imageSrc } = e.data;
  
  try {
    // 1. 等待 OpenCV 初始化完成
    if (typeof cv === 'undefined' || !cv.Mat) {
      // OpenCV.js 可能还在初始化，等待其就绪
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
    let src = cv.matFromImageData(imgData);
    let h = src.rows;
    let w = src.cols;
    
    // 3. 根据手机屏幕分辨率动态计算人因工程制图参数
    const dynRadius = Math.max(5, Math.floor(w / 150));      
    const dynLine = Math.max(2, Math.floor(w / 500));        
    
    // 4. 执行核心的 V27 / V28 级联策略（限定面弯角物理合理阈值为 168.0°）
    const MIN_ANGLE = 168.0; 
    const result = runCascadeV27V28(src, w, h, MIN_ANGLE);
    
    // 5. 根据级联结果进行响应
    if (result.success && result.bestSet) {
      // 识别成功：在原图上绘制拟合骨架线与特征点
      drawMetrics(src, result.bestSet, dynLine, dynRadius);
      
      // 将带有绘制标记的 Mat 转回 ImageData 像素流
      const dstImgData = matToImageData(src);
      
      // 使用可转移对象（Transferable Objects）零拷贝传回主线程，极大提升手机端效率
      self.postMessage({
        success: true,
        angle: result.angle,
        version: result.version,
        msg: `成功（算法: ${result.version}）`,
        rgbaData: dstImgData.data, 
        width: dstImgData.width,
        height: dstImgData.height
      }, [dstImgData.data.buffer as ArrayBuffer]);
    } else {
      // V27 和 V28 级联策略均宣告失败
      self.postMessage({
        success: false,
        angle: 0,
        version: "失败",
        msg: "未组合出符合眼镜特征的骨架。请确保眼镜水平正对镜头，并重新拍照。"
      });
    }
    
    // 6. 严格释放 WebAssembly 内存，防止手机浏览器崩溃
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

// ================= 核心级联策略（V27 + V28 融合） =================
function runCascadeV27V28(src: any, w: number, h: number, minAngle: number) {
  // 分离 BGR 通道进行差值计算
  let bgrPlanes = new cv.MatVector();
  cv.split(src, bgrPlanes);
  let b = bgrPlanes.get(0);
  let g = bgrPlanes.get(1);
  let r = bgrPlanes.get(2);
  
  let rgDiff = new cv.Mat();
  let rbDiff = new cv.Mat();
  cv.subtract(r, g, rgDiff);
  cv.subtract(r, b, rbDiff);
  
  // 提前准备 HSV 颜色空间，供 V28 的后两层极端容错使用
  let hsv = new cv.Mat();
  cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB); 
  cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

  // 5 层级联阈值结构（前3层属V27级联，后2层属V28容错）
  const cascadeThresholds = [
    // --- V27 级联层 ---
    { mode: "rgb", rg: 75, rb: 45, r: 120, circ: 0.55, areaMin: 12, version: "V27 (Pass 1)" },
    { mode: "rgb", rg: 55, rb: 40, r: 100, circ: 0.45, areaMin: 10, version: "V27 (Pass 2)" },
    { mode: "rgb", rg: 40, rb: 30, r: 80,  circ: 0.35, areaMin: 8,  version: "V27 (Pass 3)" },
    // --- V28 增强容错层 ---
    { mode: "hsv", hLow: 0,   hHigh: 10,  sLow: 30, vLow: 60, circ: 0.20, areaMin: 3, version: "V28 (HSV-1)" },
    { mode: "hsv", hLow: 165, hHigh: 180, sLow: 30, vLow: 60, circ: 0.20, areaMin: 3, version: "V28 (HSV-2)" }
  ];
  
  let bestSet: any = null;
  let minGeometricError = Infinity;
  let finalAngle = 0;
  let matchedVersion = "无";

  // 逐层遍历级联阈值
  for (let th of cascadeThresholds) {
    let mask = new cv.Mat();
    
    if (th.mode === "rgb") {
      let mask1 = new cv.Mat();
      let mask2 = new cv.Mat();
      let mask3 = new cv.Mat();
      cv.threshold(rgDiff, mask1, th.rg!, 255, cv.THRESH_BINARY);
      cv.threshold(rbDiff, mask2, th.rb!, 255, cv.THRESH_BINARY);
      cv.threshold(r, mask3, th.r!, 255, cv.THRESH_BINARY);
      
      cv.bitwise_and(mask1, mask2, mask);
      cv.bitwise_and(mask, mask3, mask);
      
      mask1.delete(); mask2.delete(); mask3.delete();
    } else {
      let lowBound = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [th.hLow!, th.sLow!, th.vLow!, 0]);
      let highBound = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [th.hHigh!, 255, 255, 255]);
      cv.inRange(hsv, lowBound, highBound, mask);
      lowBound.delete(); highBound.delete();
    }
    
    // 形态学处理（闭运算连接断开的红色特征点区域）
    let ksize = th.mode === "rgb" ? new cv.Size(5, 5) : new cv.Size(7, 7);
    let kernelClose = cv.getStructuringElement(cv.MORPH_ELLIPSE, ksize);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernelClose);
    kernelClose.delete();
    
    // V28 追加一次小核膨胀提升边缘鲁棒性
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
            
            // 剔除贴近手机屏幕物理边缘的噪点（2% 边缘安全区）
            if (0.02 * w < cX && cX < 0.98 * w && 0.02 * h < cY && cY < 0.98 * h) {
              candidates.push({ cX, cY, area });
            }
          }
        }
      }
    }
    
    // 按面积从大到小排序
    candidates.sort((a, b) => b.area - a.area);
    let pts = th.mode === "rgb" ? candidates.slice(0, 12) : candidates.slice(0, 15);
    
    // 三点空间几何校验与骨架拟合
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
            
            // 约束智能眼镜物理镜片跨度的最小特征比例
            if (maxDist < Math.min(w, h) * 0.30) continue;
            
            // 定位中点 (p_mid) 与外侧翼点 (p1, p2)
            let p_mid, p1, p2;
            if (maxDist === dAB) { p_mid = pC; p1 = pA; p2 = pB; }
            else if (maxDist === dBC) { p_mid = pA; p1 = pB; p2 = pC; }
            else { p_mid = pB; p1 = pA; p2 = pC; }
            
            // 解算三点向量夹角
            let v1 = { x: p1.cX - p_mid.cX, y: p1.cY - p_mid.cY };
            let v2 = { x: p2.cX - p_mid.cX, y: p2.cY - p_mid.cY };
            
            let dot = v1.x * v2.x + v1.y * v2.y;
            let len1 = Math.hypot(v1.x, v1.y);
            let len2 = Math.hypot(v2.x, v2.y);
            let cosTheta = dot / (len1 * len2);
            let angle = (Math.acos(Math.min(Math.max(cosTheta, -1.0), 1.0)) * 180) / Math.PI;
            
            // 限定合理夹角区间
            if (angle < 160 || angle > 180) continue;
            
            // 对称性校验
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

// ================= 辅助可视化绘制 =================
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
  let img = new cv.Mat();
  cv.cvtColor(mat, img, cv.COLOR_BGRA2RGBA);
  let imgData = new ImageData(new Uint8ClampedArray(img.data), img.cols, img.rows);
  img.delete();
  return imgData;
}