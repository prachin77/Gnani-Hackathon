import { useEffect, useRef } from "react";

interface AudioVisualizerProps {
  analyser: AnalyserNode | null;
  active: boolean;
}

const BAR_COUNT = 48;

/**
 * Mirrored frequency-bar visualizer driven by an AnalyserNode.
 * Falls back to a calm baseline when no audio graph is active.
 */
export function AudioVisualizer({ analyser, active }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const levels = new Float32Array(BAR_COUNT);
    const frequencyData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;

    let width = 1;
    let height = 1;
    let frameHandle = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = () => {
      context.clearRect(0, 0, width, height);

      const gap = Math.max(2, width / 260);
      const barWidth = Math.max(2, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
      const centerY = height / 2;
      const maxBarHeight = Math.max(4, height - 10);

      if (analyser && frequencyData && active) {
        try {
          analyser.getByteFrequencyData(frequencyData);
        } catch {
          frequencyData.fill(0);
        }
        const usableBins = Math.max(1, Math.floor(frequencyData.length * 0.55));

        for (let i = 0; i < BAR_COUNT; i += 1) {
          const start = Math.floor((i / BAR_COUNT) * usableBins);
          const end = Math.max(start + 1, Math.floor(((i + 1) / BAR_COUNT) * usableBins));

          let sum = 0;
          for (let bin = start; bin < end; bin += 1) sum += frequencyData[bin];

          const average = sum / (end - start) / 255;
          const target = Math.min(1, Math.pow(average, 0.82) * 1.7);
          const smoothing = target > levels[i] ? 0.5 : 0.14;
          levels[i] += (target - levels[i]) * smoothing;
        }
      } else {
        for (let i = 0; i < BAR_COUNT; i += 1) {
          levels[i] += (0 - levels[i]) * 0.15;
        }
      }

      const gradient = context.createLinearGradient(0, 0, 0, height);
      if (active) {
        gradient.addColorStop(0, "#6366f1");
        gradient.addColorStop(1, "#a5b4fc");
      } else {
        gradient.addColorStop(0, "#cbd5e1");
        gradient.addColorStop(1, "#e2e8f0");
      }
      context.fillStyle = gradient;

      for (let i = 0; i < BAR_COUNT; i += 1) {
        const level = active ? levels[i] : 0.035;
        const barHeight = Math.max(3, level * maxBarHeight);
        const x = i * (barWidth + gap);
        const y = centerY - barHeight / 2;
        const radius = Math.min(barWidth / 2, 3);

        context.beginPath();
        if (typeof context.roundRect === "function") {
          context.roundRect(x, y, barWidth, barHeight, radius);
        } else {
          context.rect(x, y, barWidth, barHeight);
        }
        context.fill();
      }

      frameHandle = window.requestAnimationFrame(draw);
    };

    frameHandle = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(frameHandle);
      observer.disconnect();
    };
  }, [analyser, active]);

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-3 pb-1 pt-3">
      <canvas ref={canvasRef} className="h-14 w-full" aria-hidden="true" />
    </div>
  );
}
