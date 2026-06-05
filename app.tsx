// App.tsx
import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

export default function App() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [angleResult, setAngleResult] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('等待载入眼镜图像');
  const [loading, setLoading] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 当用户拍照或上传图片时触发
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setStatus('正在进行人因测量分辨率优化...');
    setAngleResult(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200; // 匹配算法理想物理宽度约束
        let width = img.width;
        let height = img.height;

        if (width > MAX_WIDTH) {
          height = Math.round((height * MAX_WIDTH) / width);
          width = MAX_WIDTH;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        
        // 缩减传输基底体积
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setImageSrc(compressedDataUrl);
        setLoading(false);
        setStatus('图片加载完成，可进行精密分析');

        // 在主画布上初始化原图预览
        drawBaseImageToCanvas(compressedDataUrl);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  // 辅助函数：初始化画布
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

  // 运行骨架级联解算
  const triggerAlgorithm = () => {
    if (!imageSrc) return;
    setLoading(true);
    setStatus('级联核心策略运行中...');
    
    // 初始化 Web Worker
    const worker = new Worker(new URL('./cv.worker.ts', import.meta.url));
    worker.postMessage({ imageSrc });
    
    // 监听 Worker 零拷贝传回的像素数据
    worker.onmessage = (e) => {
      const { success, angle, msg, version, rgbaData, width, height } = e.data;
      setLoading(false);
      
      if (success) {
        setStatus(`测量成功！系统判别：${version}`);
        setAngleResult(angle);
        
        // 【已修复】利用 Canvas 动态更新带骨架标记的结果图，省去 Base64 编解码耗时
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
        // 【核心要求】若 V27/V28 级联皆失败，重置状态并警告提示重新拍照
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

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-between p-4 font-sans select-none">
      {/* 状态看板 */}
      <div className="bg-white p-4 rounded-2xl shadow-sm text-center">
        <h1 className="text-xl font-bold text-gray-800 tracking-wide">面弯角精密测量系统</h1>
        <p className={`text-xs mt-1 font-medium ${loading ? 'text-blue-500 animate-pulse' : 'text-gray-400'}`}>{status}</p>
      </div>

      {/* 核心图形渲染区 */}
      <div className="relative flex-1 my-4 bg-gray-900 rounded-3xl overflow-hidden flex items-center justify-center shadow-inner min-h-[300px]">
        <canvas ref={canvasRef} className={`max-w-full max-h-full object-contain ${!imageSrc ? 'hidden' : 'block'}`} />
        
        {!imageSrc && (
          <div className="text-gray-500 text-center px-6 absolute pointer-events-none">
            <div className="text-4xl mb-3">🕶️</div>
            <p className="text-sm font-medium text-gray-400">请保持手机平行</p>
            <p className="text-xs text-gray-600 mt-1">将智能眼镜水平置于视野中心拍照</p>
          </div>
        )}
        
        {/* 人因交互指引靶心 */}
        {!imageSrc && (
          <div className="absolute inset-8 border border-dashed border-gray-700 rounded-2xl pointer-events-none flex items-center justify-center">
            <div className="w-full h-[1px] bg-gray-800"></div>
            <div className="h-full w-[1px] bg-gray-800"></div>
          </div>
        )}
      </div>

      {/* 控制面板 */}
      <div className="bg-white p-5 rounded-3xl shadow-md space-y-4">
        {angleResult !== null && (
          <div className="text-center bg-gray-50 py-3 rounded-2xl border border-blue-50/50 animate-fade-in">
            <span className="text-[10px] text-gray-400 block uppercase tracking-widest font-bold">Face Wrap Angle</span>
            <span className="text-3xl font-black text-blue-600">{angleResult.toFixed(2)}°</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
          
          <button onClick={() => fileInputRef.current?.click()} className="py-4 bg-gray-900 text-white font-semibold rounded-2xl active:scale-95 transition-all flex flex-col items-center justify-center shadow-sm">
            <span className="text-xl">📸</span>
            <span className="text-xs mt-1">拍摄眼镜</span>
          </button>
          
          <button onClick={triggerAlgorithm} disabled={!imageSrc || loading} className="py-4 bg-blue-600 disabled:bg-gray-100 disabled:text-gray-400 text-white font-semibold rounded-2xl active:scale-95 disabled:active:scale-100 transition-all flex flex-col items-center justify-center shadow-sm">
            <span className="text-xl">📐</span>
            <span className="text-xs mt-1">精密分析</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<App />);
}