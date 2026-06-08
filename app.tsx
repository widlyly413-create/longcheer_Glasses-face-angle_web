import React, { useState, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// ============================================================
//  角度计算（手动模式）
// ============================================================
function calcAngle(pL: {x:number,y:number}, pM: {x:number,y:number}, pR: {x:number,y:number}) {
  const v1 = { x: pL.x - pM.x, y: pL.y - pM.y };
  const v2 = { x: pR.x - pM.x, y: pR.y - pM.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
  const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
  const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.acos(cos) * 180 / Math.PI;
}

export default function App() {
  // ============================================================
  //  已有状态（自动模式）
  // ============================================================
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [angleResult, setAngleResult] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('等待载入眼镜图像');
  const [loading, setLoading] = useState<boolean>(false);
  const [userId, setUserId] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ============================================================
  //  手动模式状态
  // ============================================================
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [manualPoints, setManualPoints] = useState<Array<{x:number,y:number}>>([]);
  const [manualAngle, setManualAngle] = useState<number | null>(null);
  const [adjustingIdx, setAdjustingIdx] = useState<number>(-1); // -1=未调整, 0/1/2=正在调整对应的点
  const rawImgRef = useRef<HTMLImageElement | null>(null); // 原始图片对象
  const imgNaturalRef = useRef<{w:number,h:number} | null>(null);

  // 步骤文字
  const stepLabels = ['① 点击左边框拐角', '② 点击鼻梁正中', '③ 点击右边框拐角'];

  // ============================================================
  //  图片上传（同时兼容两种模式）
  // ============================================================
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setStatus('正在载入图像...');
    setAngleResult(null);
    setManualPoints([]);
    setManualAngle(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // 压缩至 1200px 以内
        const MAX_WIDTH = 1200;
        let width = img.width;
        let height = img.height;
        if (width > MAX_WIDTH) {
          height = Math.round((height * MAX_WIDTH) / width);
          width = MAX_WIDTH;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.85);

        // 存储原始图片信息
        rawImgRef.current = img;
        imgNaturalRef.current = { w: img.width, h: img.height };

        setImageSrc(compressedDataUrl);
        setLoading(false);

        if (mode === 'auto') {
          setStatus('图像优化完成，正在进行骨架级联解算...');
          drawBaseImageToCanvas(compressedDataUrl);
          runAnalysis(compressedDataUrl, userId);
        } else {
          setStatus('请在图片上点击 3 个点');
          drawImageToCanvas(compressedDataUrl, width, height);
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  // ============================================================
  //  Canvas 绘制：自动模式 - 原始底图
  // ============================================================
  const drawBaseImageToCanvas = (dataUrl: string) => {
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0);
    };
    img.src = dataUrl;
  };

  // ============================================================
  //  Canvas 绘制：手动模式 - 图片 + 标注
  // ============================================================
  const drawImageToCanvas = useCallback((dataUrl: string, w: number, h: number) => {
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      // 已有点的标注由 drawAnnotations 负责
      drawAnnotations(ctx, w, h, []);
    };
    img.src = dataUrl;
  }, []);

  // ============================================================
  //  绘制手动模式的标注
  // ============================================================
  const drawAnnotations = (ctx: CanvasRenderingContext2D, cw: number, ch: number, pts: Array<{x:number,y:number}>) => {
    const imgNat = imgNaturalRef.current;
    if (!imgNat) return;

    // 计算 canvas 坐标 ↔ 图片坐标 的缩放比
    const scaleX = imgNat.w / cw;
    const scaleY = imgNat.h / ch;

    const fs = Math.max(0.7, cw / 900);
    const dotR = Math.max(7, Math.round(9 * fs));
    const crossLen = Math.max(9, Math.round(13 * fs));
    const lw = Math.max(1.5, Math.round(1.5 * fs));

    const colors = ['#00c853', '#ff1744', '#2979ff'];

    // 绘制已点击的点
    for (let i = 0; i < pts.length; i++) {
      const cx = pts[i].x / scaleX;
      const cy = pts[i].y / scaleY;
      const isAdjusting = i === adjustingIdx;
      const curColor = colors[i];

      // 微调中的点：先画外发光环
      if (isAdjusting) {
        ctx.beginPath();
        ctx.arc(cx, cy, dotR * 2.2, 0, Math.PI * 2);
        ctx.strokeStyle = curColor;
        ctx.lineWidth = lw * 2;
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      // 空心圈
      ctx.beginPath();
      ctx.arc(cx, cy, isAdjusting ? dotR * 1.3 : dotR, 0, Math.PI * 2);
      ctx.strokeStyle = curColor;
      ctx.lineWidth = isAdjusting ? lw + 2 : lw + 0.5;
      ctx.stroke();
      // 十字线
      const cl = isAdjusting ? crossLen * 1.4 : crossLen;
      ctx.beginPath();
      ctx.moveTo(cx - cl, cy);
      ctx.lineTo(cx + cl, cy);
      ctx.moveTo(cx, cy - cl);
      ctx.lineTo(cx, cy + cl);
      ctx.strokeStyle = curColor;
      ctx.lineWidth = isAdjusting ? lw + 1 : lw;
      ctx.stroke();
      // 中心小点
      ctx.beginPath();
      ctx.arc(cx, cy, isAdjusting ? 3 : 1.5, 0, Math.PI * 2);
      ctx.fillStyle = curColor;
      ctx.fill();
    }

    // 连线（2个点以上）
    if (pts.length >= 2) {
      const p_m = pts[Math.min(1, pts.length - 1)];
      const others = pts.length === 3 ? [pts[0], pts[2]] : [pts[0]];
      for (const p of others) {
        if (p === p_m) continue;
        ctx.beginPath();
        ctx.moveTo(p_m.x / scaleX, p_m.y / scaleY);
        ctx.lineTo(p.x / scaleX, p.y / scaleY);
        ctx.strokeStyle = '#ff6d00';
        ctx.lineWidth = lw;
        ctx.setLineDash([Math.round(7 * fs), Math.round(3 * fs)]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 3 个点齐全：角度弧线和文字
    if (pts.length === 3) {
      const angle = calcAngle(pts[0], pts[1], pts[2]);
      setManualAngle(angle);

      const p_m = pts[1];
      const cx = p_m.x / scaleX, cy = p_m.y / scaleY;
      const v1 = { x: pts[0].x - p_m.x, y: pts[0].y - p_m.y };
      const v2 = { x: pts[2].x - p_m.x, y: pts[2].y - p_m.y };
      const a1 = Math.atan2(v1.y, v1.x);
      const a2 = Math.atan2(v2.y, v2.x);
      let startA = a1, endA = a2;
      let diff = endA - startA;
      if (diff < 0) diff += Math.PI * 2;
      if (diff > Math.PI) [startA, endA] = [endA, startA];

      const arcR = Math.min(70, Math.max(35, cw * 0.07));
      ctx.beginPath();
      ctx.arc(cx, cy, arcR, startA, endA);
      ctx.strokeStyle = '#ff1744';
      ctx.lineWidth = lw + 1;
      ctx.stroke();

      // 角度文字
      const midA = (startA + endA) / 2;
      const textR = arcR + 25 * fs;
      const tx = cx + Math.cos(midA) * textR;
      const ty = cy + Math.sin(midA) * textR;
      ctx.font = `bold ${Math.round(20 * fs)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const txt = `${angle.toFixed(2)}°`;
      const tm = ctx.measureText(txt);
      const pad = 6 * fs;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(tx - tm.width/2 - pad, ty - 13*fs - pad, tm.width + pad*2, 26*fs + pad*2);
      ctx.fillStyle = '#ff1744';
      ctx.fillText(txt, tx, ty);
    }
  };

  // ============================================================
  //  手动模式 Canvas 点击（含微调功能）
  // ============================================================
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== 'manual') return;
    const canvas = canvasRef.current;
    if (!canvas || !imgNaturalRef.current) return;

    const rect = canvas.getBoundingClientRect();
    // === 修复1: 用 rect.width/height (CSS显示尺寸) 代替 canvas.width/height ===
    const scaleX = imgNaturalRef.current.w / rect.width;
    const scaleY = imgNaturalRef.current.h / rect.height;
    const imgX = Math.round((e.clientX - rect.left) * scaleX);
    const imgY = Math.round((e.clientY - rect.top) * scaleY);

    // --- 情况A: 正在微调中，把当前点移到新位置 ---
    if (adjustingIdx >= 0) {
      const newPts = manualPoints.map((p, i) =>
        i === adjustingIdx ? { x: imgX, y: imgY } : p
      );
      setManualPoints(newPts);
      setAdjustingIdx(-1);
      // 重绘
      redrawCanvas(newPts);
      return;
    }

    // --- 情况B: 3 个点已齐全，检测是否点击到已有点（进入微调模式） ---
    if (manualPoints.length === 3) {
      const clickDist = 30; // 像素阈值（原始图片坐标）
      for (let i = 0; i < 3; i++) {
        const dx = manualPoints[i].x - imgX;
        const dy = manualPoints[i].y - imgY;
        if (Math.sqrt(dx * dx + dy * dy) < clickDist) {
          setAdjustingIdx(i);
          setStatus(`微调第 ${i + 1} 个点 — 点击新位置即可移动`);
          return;
        }
      }
      return; // 没点到任何已有点，忽略
    }

    // --- 情况C: 正常添加点 ---
    if (manualPoints.length >= 3) return;
    const newPts = [...manualPoints, { x: imgX, y: imgY }];
    setManualPoints(newPts);
    redrawCanvas(newPts);

    // 状态提示
    if (newPts.length < 3) {
      setStatus(`已选 ${newPts.length}/3 个点，继续点击`);
    } else {
      setStatus('测量完成！可点击已有点进行微调');
    }
  };

  // 手动模式重绘 canvas 辅助函数
  const redrawCanvas = (pts: Array<{x:number,y:number}>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = rawImgRef.current;
    if (!img) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawAnnotations(ctx, canvas.width, canvas.height, pts);
  };

  const resetManualPoints = () => {
    setManualPoints([]);
    setManualAngle(null);
    setAdjustingIdx(-1);
    setStatus('请在图片上点击 3 个点');
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = rawImgRef.current;
    if (img) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
  };

  // ============================================================
  //  手动模式：保存结果图
  // ============================================================
  const handleManualSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const angle = manualAngle?.toFixed(2) ?? 'unknown';
      link.download = `manual_angle_${angle}deg.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    }, 'image/png');
  };

  // ============================================================
  //  模式切换
  // ============================================================
  const switchMode = (newMode: 'auto' | 'manual') => {
    if (newMode === mode) return;
    setMode(newMode);
    setManualPoints([]);
    setManualAngle(null);
    setAdjustingIdx(-1);
    setAngleResult(null);

    if (newMode === 'manual' && imageSrc && rawImgRef.current) {
      setStatus('请在图片上点击 3 个点');
      const canvas = canvasRef.current;
      if (canvas) {
        const imgNat = imgNaturalRef.current;
        if (imgNat) {
          // 保持 canvas 尺寸与压缩后的图片一致
          const MAX_WIDTH = 1200;
          let w = imgNat.w, h = imgNat.h;
          if (w > MAX_WIDTH) {
            h = Math.round((h * MAX_WIDTH) / w);
            w = MAX_WIDTH;
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(rawImgRef.current, 0, 0, w, h);
          }
        }
      }
    } else if (newMode === 'auto' && imageSrc) {
      setStatus('图像优化完成，正在进行骨架级联解算...');
      drawBaseImageToCanvas(imageSrc);
      runAnalysis(imageSrc, userId);
    }
  };

  // ============================================================
  //  自动分析（原方法保持不变）
  // ============================================================
  const runAnalysis = (src: string, uid: string) => {
    setLoading(true);
    setStatus('级联核心策略运行中...');
    
    const worker = new Worker(new URL('./cv.worker.ts', import.meta.url));
    worker.postMessage({ imageSrc: src, userId: uid });
    
    worker.onmessage = (e) => {
      const { success, angle, msg, version, rgbaData, width, height } = e.data;
      setLoading(false);
      
      if (success) {
        setStatus(`测量成功！系统判别：${version}`);
        setAngleResult(angle);
        
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const imgData = ctx.createImageData(width, height);
            imgData.data.set(rgbaData);
            ctx.putImageData(imgData, 0, 0);
          }
        }
      } else {
        setStatus('分析未通过');
        setAngleResult(null);
        alert(`⚠️ 测量失败\n\n原因：${msg}`);
      }
      worker.terminate();
    };

    worker.onerror = () => {
      setLoading(false);
      setStatus('计算异常');
      alert('算法并发异常，请尝试重新拍摄。');
      worker.terminate();
    };
  };

  // ============================================================
  //  重新拍摄
  // ============================================================
  const handleRetake = () => {
    setImageSrc(null);
    setAngleResult(null);
    setManualPoints([]);
    setManualAngle(null);
    setStatus('等待载入眼镜图像');
    rawImgRef.current = null;
    imgNaturalRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  // ============================================================
  //  自动模式保存
  // ============================================================
  const handleAutoSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
      const fileName = userId ? `${userId}.jpg` : `face_angle_${timestamp}.jpg`;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    }, 'image/jpeg', 0.95);
  };

  // ============================================================
  //  渲染
  // ============================================================
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-between p-4 font-sans select-none">
      {/* 状态看板 */}
      <div className="bg-white p-4 rounded-2xl shadow-sm text-center">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h1 className="text-xl font-bold text-gray-800 tracking-wide">面弯角精密测量系统</h1>
          <input
            type="text"
            placeholder="用户编号"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="w-28 text-center text-sm border border-gray-300 rounded-lg py-1.5 px-2 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
          />
        </div>

        {/* 模式切换 */}
        <div className="flex gap-1 mb-2 bg-gray-100 p-1 rounded-xl">
          <button
            onClick={() => switchMode('auto')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${mode === 'auto' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}`}
          >
            🤖 自动检测
          </button>
          <button
            onClick={() => switchMode('manual')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${mode === 'manual' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}`}
          >
            👆 手动选点
          </button>
        </div>

        <p className={`text-xs font-medium ${loading ? 'text-blue-500 animate-pulse' : 'text-gray-400'}`}>{status}</p>
      </div>

      {/* 核心图形渲染区 */}
      <div className="relative flex-1 my-4 bg-gray-900 rounded-3xl overflow-hidden flex items-center justify-center shadow-inner min-h-[300px]">
        <canvas
          ref={canvasRef}
          className="max-w-full max-h-full w-auto h-auto object-contain"
          style={{
            display: imageSrc ? 'block' : 'none',
            maxWidth: '100%',
            maxHeight: '100%',
            cursor: mode === 'manual' && manualPoints.length < 3 ? 'crosshair'
                    : mode === 'manual' && adjustingIdx >= 0 ? 'move'
                    : mode === 'manual' ? 'pointer'
                    : 'default'
          }}
          onClick={handleCanvasClick}
        />
        
        {!imageSrc && (
          <div className="text-gray-500 text-center px-6 absolute pointer-events-none">
            <div className="text-4xl mb-3">🕶️</div>
            <p className="text-sm font-medium text-gray-400">请保持手机平行</p>
            <p className="text-xs text-gray-600 mt-1">将智能眼镜水平置于视野中心拍照</p>
          </div>
        )}
        
        {!imageSrc && (
          <div className="absolute inset-8 border border-dashed border-gray-700 rounded-2xl pointer-events-none flex items-center justify-center">
            <div className="w-full h-[1px] bg-gray-800"></div>
            <div className="h-full w-[1px] bg-gray-800"></div>
          </div>
        )}
      </div>

      {/* 手动模式步骤指引 */}
      {mode === 'manual' && imageSrc && (
        <div className="flex flex-wrap justify-center gap-2 mb-2 text-xs">
          {stepLabels.map((label, i) => (
            <span
              key={i}
              className={`px-3 py-1 rounded-full font-medium transition-all ${
                i === adjustingIdx
                  ? 'bg-yellow-100 text-yellow-700 border border-yellow-400 ring-2 ring-yellow-300'
                  : i < manualPoints.length
                  ? 'bg-green-100 text-green-700 border border-green-300'
                  : i === manualPoints.length
                  ? 'bg-blue-100 text-blue-700 border border-blue-300 animate-pulse'
                  : 'bg-gray-100 text-gray-400 border border-gray-200'
              }`}
            >
              {label}
            </span>
          ))}
          {adjustingIdx >= 0 && (
            <button
              onClick={() => { setAdjustingIdx(-1); setStatus('测量完成！可点击已有点进行微调'); }}
              className="px-3 py-1 rounded-full font-medium text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 active:scale-95 transition-all"
            >
              ✕ 取消微调
            </button>
          )}
        </div>
      )}

      {/* 控制面板 */}
      <div className="bg-white p-5 rounded-3xl shadow-md space-y-4">
        {/* 手动模式结果 */}
        {mode === 'manual' && manualAngle !== null && (
          <div className="text-center bg-gray-50 py-3 rounded-2xl border border-blue-50/50 animate-fade-in">
            <span className="text-[10px] text-gray-400 block uppercase tracking-widest font-bold">Face Wrap Angle</span>
            <span className="text-3xl font-black text-blue-600">{manualAngle.toFixed(2)}°</span>
          </div>
        )}

        {/* 自动模式结果 */}
        {mode === 'auto' && angleResult !== null && (
          <div className="text-center bg-gray-50 py-3 rounded-2xl border border-blue-50/50 animate-fade-in">
            <span className="text-[10px] text-gray-400 block uppercase tracking-widest font-bold">Face Wrap Angle</span>
            <span className="text-3xl font-black text-blue-600">{angleResult.toFixed(2)}°</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
          
          <button onClick={() => fileInputRef.current?.click()} disabled={loading} className="py-4 bg-gray-900 disabled:bg-gray-100 disabled:text-gray-400 text-white font-semibold rounded-2xl active:scale-95 disabled:active:scale-100 transition-all flex flex-col items-center justify-center shadow-sm">
            <span className="text-xl">📸</span>
            <span className="text-xs mt-1">拍摄眼镜</span>
          </button>
          
          <button onClick={handleRetake} disabled={!imageSrc || loading} className="py-4 bg-blue-600 disabled:bg-gray-100 disabled:text-gray-400 text-white font-semibold rounded-2xl active:scale-95 disabled:active:scale-100 transition-all flex flex-col items-center justify-center shadow-sm">
            <span className="text-xl">🔄</span>
            <span className="text-xs mt-1">重新拍摄</span>
          </button>
        </div>

        {/* 手动模式：重置选点 + 保存 */}
        {mode === 'manual' && manualPoints.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <button onClick={resetManualPoints} className="w-full py-3 bg-gray-200 text-gray-700 font-semibold rounded-2xl active:scale-95 transition-all flex items-center justify-center gap-2 shadow-sm">
              <span className="text-lg">↩️</span>
              <span className="text-sm">重新选点</span>
            </button>
            {manualAngle !== null && (
              <button onClick={handleManualSave} className="w-full py-3 bg-green-600 text-white font-semibold rounded-2xl active:scale-95 transition-all flex items-center justify-center gap-2 shadow-sm">
                <span className="text-lg">💾</span>
                <span className="text-sm">保存结果图</span>
              </button>
            )}
          </div>
        )}

        {/* 自动模式：保存按钮 */}
        {mode === 'auto' && angleResult !== null && (
          <button onClick={handleAutoSave} className="w-full py-3 bg-green-600 text-white font-semibold rounded-2xl active:scale-95 transition-all flex items-center justify-center gap-2 shadow-sm">
            <span className="text-lg">💾</span>
            <span className="text-sm">保存到相册{userId ? `（${userId}.jpg）` : ''}</span>
          </button>
        )}
      </div>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<App />);
}
