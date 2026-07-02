import React, { useState, useRef, useCallback } from 'react';
// @ts-ignore heic2any 无内置 TS 类型声明
import heic2any from 'heic2any';

// ============================================================
//  角度计算（纯函数）
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
  //  状态管理
  // ============================================================
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [angleResult, setAngleResult] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('等待载入眼镜图像');
  const [loading, setLoading] = useState<boolean>(false);
  const [userId, setUserId] = useState<string>('');
  
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [manualPoints, setManualPoints] = useState<Array<{x:number,y:number}>>([]);
  const [manualAngle, setManualAngle] = useState<number | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number>(-1);
  const [isDragOver, setIsDragOver] = useState(false);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{points: Array<{x:number,y:number}>}>({ points: [] });
  const rawImgRef = useRef<HTMLImageElement | null>(null);
  const imgNaturalRef = useRef<{w:number,h:number} | null>(null);
  const dragCounterRef = useRef(0);

  const stepLabels = ['① 点击左边框拐角', '② 点击鼻梁正中', '③ 点击右边框拐角'];

  // ============================================================
  //  图像处理与加载
  // ============================================================
  const isHeicFile = (file: File): boolean => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    return ext === 'heic' || ext === 'heif' || file.type === 'image/heic' || file.type === 'image/heif';
  };

  const processImageDataUrl = (dataUrl: string) => {
    const img = new Image();
    img.onload = () => {
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
    img.onerror = () => {
      setLoading(false);
      setStatus('图像解码失败，请重试');
      alert('图像解码失败，请确认文件格式正确。');
    };
    img.src = dataUrl;
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setStatus('正在载入图像...');
    setAngleResult(null);
    setManualPoints([]);
    setManualAngle(null);

    if (isHeicFile(file)) {
      setStatus('检测到 HEIC 格式，正在转换...');
      try {
        const convertedBlob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
        const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
        const reader = new FileReader();
        reader.onload = (event) => processImageDataUrl(event.target?.result as string);
        reader.readAsDataURL(resultBlob);
      } catch (err) {
        setLoading(false);
        setStatus('HEIC 转换失败');
        alert('HEIC 格式转换失败，请尝试使用 JPG/PNG 格式的图片。');
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => processImageDataUrl(event.target?.result as string);
    reader.readAsDataURL(file);
  };

  // ============================================================
  //  拖拽事件处理
  // ============================================================
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) setIsDragOver(true);
  };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragOver(false); }
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragOver(false);
    dragCounterRef.current = 0;
    const files = e.dataTransfer.files;
    if (files.length === 0) return;
    if (!files[0].type.startsWith('image/')) {
      alert('请拖入图片文件');
      return;
    }
    handleFileChange({ target: { files: [files[0]] } } as unknown as React.ChangeEvent<HTMLInputElement>);
  };

  // ============================================================
  //  Canvas 绘图与交互
  // ============================================================
  const drawBaseImageToCanvas = (dataUrl: string) => {
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = dataUrl;
  };

  const drawImageToCanvas = useCallback((dataUrl: string, w: number, h: number) => {
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        drawAnnotations(ctx, w, h, []);
      }
    };
    img.src = dataUrl;
  }, []);

  const drawAnnotations = (ctx: CanvasRenderingContext2D, cw: number, ch: number, pts: Array<{x:number,y:number}>, highlightIdx: number = -1) => {
    const imgNat = imgNaturalRef.current;
    if (!imgNat) return;
    const scaleX = imgNat.w / cw;
    const scaleY = imgNat.h / ch;
    const fs = Math.max(0.7, cw / 900);
    const dotR = Math.max(7, Math.round(9 * fs));
    const crossLen = Math.max(9, Math.round(13 * fs));
    const lw = Math.max(1.5, Math.round(1.5 * fs));
    const colors = ['#00c853', '#ff1744', '#2979ff'];

    for (let i = 0; i < pts.length; i++) {
      const cx = pts[i].x / scaleX;
      const cy = pts[i].y / scaleY;
      const isAdjusting = i === highlightIdx;
      const curColor = colors[i];

      if (isAdjusting) {
        ctx.beginPath();
        ctx.arc(cx, cy, dotR * 2.2, 0, Math.PI * 2);
        ctx.strokeStyle = curColor;
        ctx.lineWidth = lw * 2;
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      ctx.beginPath(); ctx.arc(cx, cy, isAdjusting ? dotR * 1.3 : dotR, 0, Math.PI * 2);
      ctx.strokeStyle = curColor; ctx.lineWidth = isAdjusting ? lw + 2 : lw + 0.5; ctx.stroke();
      
      const cl = isAdjusting ? crossLen * 1.4 : crossLen;
      ctx.beginPath(); ctx.moveTo(cx - cl, cy); ctx.lineTo(cx + cl, cy);
      ctx.moveTo(cx, cy - cl); ctx.lineTo(cx, cy + cl);
      ctx.strokeStyle = curColor; ctx.lineWidth = isAdjusting ? lw + 1 : lw; ctx.stroke();
      
      ctx.beginPath(); ctx.arc(cx, cy, isAdjusting ? 3 : 1.5, 0, Math.PI * 2);
      ctx.fillStyle = curColor; ctx.fill();
    }

    if (pts.length >= 2) {
      const p_m = pts[Math.min(1, pts.length - 1)];
      const others = pts.length === 3 ? [pts[0], pts[2]] : [pts[0]];
      for (const p of others) {
        if (p === p_m) continue;
        ctx.beginPath(); ctx.moveTo(p_m.x / scaleX, p_m.y / scaleY); ctx.lineTo(p.x / scaleX, p.y / scaleY);
        ctx.strokeStyle = '#ff6d00'; ctx.lineWidth = lw;
        ctx.setLineDash([Math.round(7 * fs), Math.round(3 * fs)]); ctx.stroke(); ctx.setLineDash([]);
      }
    }

    if (pts.length === 3) {
      const angle = calcAngle(pts[0], pts[1], pts[2]);
      setManualAngle(angle);

      const p_m = pts[1];
      const cx = p_m.x / scaleX, cy = p_m.y / scaleY;
      const v1 = { x: pts[0].x - p_m.x, y: pts[0].y - p_m.y };
      const v2 = { x: pts[2].x - p_m.x, y: pts[2].y - p_m.y };
      const a1 = Math.atan2(v1.y, v1.x), a2 = Math.atan2(v2.y, v2.x);
      let startA = a1, endA = a2;
      let diff = endA - startA;
      if (diff < 0) diff += Math.PI * 2;
      if (diff > Math.PI) [startA, endA] = [endA, startA];

      const arcR = Math.min(70, Math.max(35, cw * 0.07));
      ctx.beginPath(); ctx.arc(cx, cy, arcR, startA, endA);
      ctx.strokeStyle = '#ff1744'; ctx.lineWidth = lw + 1; ctx.stroke();

      const midA = (startA + endA) / 2;
      const textR = arcR + 25 * fs;
      const tx = cx + Math.cos(midA) * textR, ty = cy + Math.sin(midA) * textR;
      ctx.font = `bold ${Math.round(20 * fs)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const txt = `${angle.toFixed(2)}°`;
      const tm = ctx.measureText(txt);
      const pad = 6 * fs;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(tx - tm.width/2 - pad, ty - 13*fs - pad, tm.width + pad*2, 26*fs + pad*2);
      ctx.fillStyle = '#ff1744'; ctx.fillText(txt, tx, ty);
    }
  };

  const getImgCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !imgNaturalRef.current) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = imgNaturalRef.current.w / rect.width;
    const scaleY = imgNaturalRef.current.h / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== 'manual') return;
    const coords = getImgCoords(e);
    if (!coords) return;

    if (manualPoints.length === 3) {
      const threshold = 30;
      for (let i = 0; i < 3; i++) {
        const dx = manualPoints[i].x - coords.x;
        const dy = manualPoints[i].y - coords.y;
        if (Math.sqrt(dx * dx + dy * dy) < threshold) {
          dragRef.current = { points: [...manualPoints] };
          setDraggingIdx(i);
          setStatus(`拖动第 ${i + 1} 个点进行微调`);
          return;
        }
      }
      return;
    }

    if (manualPoints.length >= 3) return;
    const newPts = [...manualPoints, coords];
    setManualPoints(newPts);
    redrawCanvas(newPts);
    setStatus(newPts.length < 3 ? `已选 ${newPts.length}/3 个点，继续点击` : '✅ 测量完成 — 拖动任意点进行微调');
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx < 0) return;
    const coords = getImgCoords(e);
    if (!coords) return;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const img = rawImgRef.current;
    if (!canvas || !ctx || !img) return;

    const newPts = dragRef.current.points.map((p, i) => i === draggingIdx ? coords : p);
    dragRef.current.points = newPts;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawAnnotations(ctx, canvas.width, canvas.height, newPts, draggingIdx);
  };

  const handlePointerUp = () => {
    if (draggingIdx < 0) return;
    const finalPts = dragRef.current.points;
    setManualPoints(finalPts);
    setDraggingIdx(-1);
    setStatus('✅ 微调完成 — 拖动任意点继续微调');
    redrawCanvas(finalPts);
  };

  const redrawCanvas = (pts: Array<{x:number,y:number}>) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const img = rawImgRef.current;
    if (!canvas || !ctx || !img) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawAnnotations(ctx, canvas.width, canvas.height, pts);
  };

  const resetManualPoints = () => {
    setManualPoints([]); setManualAngle(null); setDraggingIdx(-1);
    setStatus('请在图片上点击 3 个点');
    redrawCanvas([]);
  };

  // ============================================================
  //  自动分析与模式切换
  // ============================================================
  const runAnalysis = (src: string, uid: string) => {
    setLoading(true); setStatus('级联核心策略运行中...');
    const worker = new Worker(new URL('./cv.worker.ts', import.meta.url));
    
    const timeout = setTimeout(() => {
      setLoading(false); setStatus('计算超时');
      alert('分析超时，OpenCV 引擎加载失败。请检查网络连接后重试。');
      worker.terminate();
    }, 30000);

    worker.postMessage({ imageSrc: src, userId: uid });
    worker.onmessage = (e) => {
      clearTimeout(timeout);
      const { success, angle, msg, version, rgbaData, width, height } = e.data;
      setLoading(false);
      
      if (success) {
        setStatus(`测量成功！系统判别：${version}`);
        setAngleResult(angle);
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const imgData = ctx.createImageData(width, height);
            imgData.data.set(rgbaData);
            ctx.putImageData(imgData, 0, 0);
          }
        }
      } else {
        setStatus('分析未通过'); setAngleResult(null);
        alert(`⚠️ 测量失败\n\n原因：${msg}`);
      }
      worker.terminate();
    };
    worker.onerror = () => {
      clearTimeout(timeout); setLoading(false); setStatus('计算异常');
      alert('OpenCV 视觉引擎加载失败，请尝试重新拍摄或切换手动模式。');
      worker.terminate();
    };
  };

  const switchMode = (newMode: 'auto' | 'manual') => {
    if (newMode === mode) return;
    setMode(newMode);
    setManualPoints([]); setManualAngle(null); setDraggingIdx(-1); setAngleResult(null);

    if (newMode === 'manual' && imageSrc && rawImgRef.current && imgNaturalRef.current) {
      setStatus('请在图片上点击 3 个点');
      const canvas = canvasRef.current;
      if (canvas) {
        const MAX_WIDTH = 1200;
        let { w, h } = imgNaturalRef.current;
        if (w > MAX_WIDTH) { h = Math.round((h * MAX_WIDTH) / w); w = MAX_WIDTH; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')?.drawImage(rawImgRef.current, 0, 0, w, h);
      }
    } else if (newMode === 'auto' && imageSrc) {
      setStatus('图像优化完成，正在进行骨架级联解算...');
      drawBaseImageToCanvas(imageSrc);
      runAnalysis(imageSrc, userId);
    }
  };

  const handleRetake = () => {
    setImageSrc(null); setAngleResult(null); setManualPoints([]); setManualAngle(null);
    setDraggingIdx(-1); setStatus('等待载入眼镜图像');
    rawImgRef.current = null; imgNaturalRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const saveCanvasData = (fileName: string) => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link); link.click();
      document.body.removeChild(link); URL.revokeObjectURL(link.href);
    }, 'image/jpeg', 0.95);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-between p-4 font-sans select-none relative" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-blue-500/90 flex flex-col items-center justify-center rounded-none pointer-events-none">
          <div className="text-6xl mb-4">📥</div>
          <p className="text-white text-xl font-bold">释放图片以导入</p>
          <p className="text-blue-100 text-sm mt-2">支持 JPG、PNG、HEIC 格式</p>
        </div>
      )}

      <div className="bg-white p-4 rounded-2xl shadow-sm text-center">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h1 className="text-xl font-bold text-gray-800 tracking-wide">面弯角精密测量系统</h1>
          <input type="text" placeholder="用户编号" value={userId} onChange={(e) => setUserId(e.target.value)} className="w-28 text-center text-sm border border-gray-300 rounded-lg py-1.5 px-2 focus:outline-none focus:ring-2 focus:ring-blue-400" />
        </div>
        <div className="flex gap-1 mb-2 bg-gray-100 p-1 rounded-xl">
          <button onClick={() => switchMode('auto')} className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${mode === 'auto' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}`}>🤖 自动检测</button>
          <button onClick={() => switchMode('manual')} className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${mode === 'manual' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}`}>👆 手动选点</button>
        </div>
        <p className={`text-xs font-medium ${loading ? 'text-blue-500 animate-pulse' : 'text-gray-400'}`}>{status}</p>
      </div>

      <div className="relative flex-1 my-4 bg-gray-900 rounded-3xl overflow-hidden flex items-center justify-center shadow-inner min-h-[300px]">
        <canvas ref={canvasRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} className="max-w-full max-h-full w-auto h-auto object-contain" style={{ display: imageSrc ? 'block' : 'none', touchAction: 'none', cursor: mode === 'manual' && draggingIdx >= 0 ? 'grabbing' : mode === 'manual' && manualPoints.length < 3 ? 'crosshair' : mode === 'manual' ? 'pointer' : 'default' }} />
        {!imageSrc && (
          <div className="text-gray-500 text-center px-6 absolute pointer-events-none">
            <div className="text-4xl mb-3">🕶️</div><p className="text-sm font-medium text-gray-400">请保持手机平行</p><p className="text-xs text-gray-600 mt-1">将智能眼镜水平置于视野中心拍照</p>
          </div>
        )}
      </div>

      {mode === 'manual' && imageSrc && (
        <div className="flex flex-wrap justify-center gap-2 mb-2 text-xs">
          {stepLabels.map((label, i) => (
            <span key={i} className={`px-3 py-1 rounded-full font-medium transition-all ${i === draggingIdx ? 'bg-yellow-100 text-yellow-700 border-yellow-400 ring-2' : i < manualPoints.length ? 'bg-green-100 text-green-700 border-green-300' : i === manualPoints.length ? 'bg-blue-100 text-blue-700 border-blue-300 animate-pulse' : 'bg-gray-100 text-gray-400'}`}>{label}</span>
          ))}
        </div>
      )}

      <div className="bg-white p-5 rounded-3xl shadow-md space-y-4">
        {(mode === 'manual' ? manualAngle : angleResult) !== null && (
          <div className="text-center bg-gray-50 py-3 rounded-2xl border border-blue-50/50 animate-fade-in">
            <span className="text-[10px] text-gray-400 block uppercase tracking-widest font-bold">Face Wrap Angle</span>
            <span className="text-3xl font-black text-blue-600">{(mode === 'manual' ? manualAngle : angleResult)?.toFixed(2)}°</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} disabled={loading} className="py-4 bg-gray-900 disabled:bg-gray-100 text-white font-semibold rounded-2xl active:scale-95 transition-all flex flex-col items-center shadow-sm">
            <span className="text-xl">📸</span><span className="text-xs mt-1">拍摄眼镜</span>
          </button>
          <button onClick={handleRetake} disabled={!imageSrc || loading} className="py-4 bg-blue-600 disabled:bg-gray-100 disabled:text-gray-400 text-white font-semibold rounded-2xl active:scale-95 transition-all flex flex-col items-center shadow-sm">
            <span className="text-xl">🔄</span><span className="text-xs mt-1">重新拍摄</span>
          </button>
        </div>

        {mode === 'manual' && manualPoints.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <button onClick={resetManualPoints} className="w-full py-3 bg-gray-200 text-gray-700 font-semibold rounded-2xl active:scale-95 transition-all flex items-center justify-center gap-2 shadow-sm">
              <span className="text-lg">↩️</span><span className="text-sm">重新选点</span>
            </button>
            {manualAngle !== null && (
              <button onClick={() => saveCanvasData(`manual_angle_${manualAngle.toFixed(2)}deg.jpg`)} className="w-full py-3 bg-green-600 text-white font-semibold rounded-2xl active:scale-95 transition-all flex items-center justify-center gap-2 shadow-sm">
                <span className="text-lg">💾</span><span className="text-sm">保存结果图</span>
              </button>
            )}
          </div>
        )}
        {mode === 'auto' && angleResult !== null && (
          <button onClick={() => saveCanvasData(userId ? `${userId}.jpg` : `face_angle_${Date.now()}.jpg`)} className="w-full py-3 bg-green-600 text-white font-semibold rounded-2xl active:scale-95 transition-all flex items-center justify-center gap-2 shadow-sm">
            <span className="text-lg">💾</span><span className="text-sm">保存到相册</span>
          </button>
        )}
      </div>
    </div>
  );
}