import { useEffect, useMemo, useRef, useState } from "react";

export interface WheelName {
  id: string;
  name: string;
  emoji: string;
}

interface Props {
  names: WheelName[];
  /** When set, the wheel spins and lands on targetId. A new key starts a new spin. */
  spin: { targetId: string; key: number } | null;
  durationMs: number;
  winnerId: string | null;
  onTick?: () => void;
  onLanded?: () => void;
}

const R = 228; // wheel radius
const RIM = 252; // marquee ring radius
const BULBS = 28;
const SEGMENT_FILLS = ["#1f5747", "#d63c55", "#f2b544", "#2b6c5a", "#b8324a", "#e5a83a"];

function ease(t: number) {
  return 1 - Math.pow(1 - t, 4);
}

function polar(angleDeg: number, r: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function segmentPath(start: number, end: number) {
  const [x1, y1] = polar(start, R);
  const [x2, y2] = polar(end, R);
  const large = end - start > 180 ? 1 : 0;
  return `M0 0 L${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

/**
 * The marquee wheel. It never decides anything: it is told which name to
 * land on, and choreographs a spin that ends there.
 */
export function Wheel({ names, spin, durationMs, winnerId, onTick, onLanded }: Props) {
  const groupRef = useRef<SVGGElement>(null);
  const rotation = useRef(0);
  const [spinning, setSpinning] = useState(false);
  const n = names.length;
  const seg = n > 0 ? 360 / n : 360;
  const fontSize = n <= 6 ? 21 : n <= 9 ? 18 : 15.5;

  const callbacks = useRef({ onTick, onLanded });
  callbacks.current = { onTick, onLanded };

  // Keep the drawn rotation in sync when the list of names changes.
  useEffect(() => {
    groupRef.current?.setAttribute("transform", `rotate(${rotation.current})`);
  }, [names]);

  useEffect(() => {
    if (!spin) return;
    const index = names.findIndex((x) => x.id === spin.targetId);
    if (index < 0 || n === 0) {
      callbacks.current.onLanded?.();
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const jitter = (Math.random() - 0.5) * seg * 0.5;
    const finalMod = (((-((index + 0.5) * seg + jitter)) % 360) + 360) % 360;
    const start = rotation.current;
    const startMod = ((start % 360) + 360) % 360;
    const turns = reduced ? 1 : 5;
    const end = start + 360 * turns + ((finalMod - startMod + 360) % 360);
    const duration = reduced ? Math.min(1500, durationMs) : durationMs;
    let lastSegment = Math.floor(((((-start) % 360) + 360) % 360) / seg);
    let lastTickAt = 0;
    let raf = 0;
    const t0 = performance.now();
    setSpinning(true);

    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const angle = start + (end - start) * ease(t);
      rotation.current = angle;
      groupRef.current?.setAttribute("transform", `rotate(${angle})`);
      const under = Math.floor(((((-angle) % 360) + 360) % 360) / seg);
      if (under !== lastSegment) {
        lastSegment = under;
        if (now - lastTickAt > 40) {
          lastTickAt = now;
          callbacks.current.onTick?.();
        }
      }
      if (t < 1) raf = requestAnimationFrame(frame);
      else {
        setSpinning(false);
        callbacks.current.onLanded?.();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // A spin is identified by its key; names are captured at spin time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spin?.key]);

  const bulbs = useMemo(
    () =>
      Array.from({ length: BULBS }, (_, i) => {
        const [x, y] = polar((360 / BULBS) * i, RIM);
        return <circle key={i} className={`bulb bulb--${i % 2}`} cx={x} cy={y} r={7.5} />;
      }),
    [],
  );

  return (
    <div className={`wheel${spinning ? " is-spinning" : ""}`}>
      <svg viewBox="-280 -290 560 570" role="img" aria-label={`Wheel with ${n} names`}>
        <defs>
          <radialGradient id="rim-glow" r="0.5">
            <stop offset="0.86" stopColor="#f2b544" stopOpacity="0" />
            <stop offset="0.95" stopColor="#f2b544" stopOpacity="0.18" />
            <stop offset="1" stopColor="#f2b544" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle r={RIM + 22} fill="url(#rim-glow)" />
        <circle r={RIM + 13} className="wheel__rim" />
        <circle r={RIM - 13} className="wheel__rim-inner" />
        {bulbs}
        <g ref={groupRef}>
          {names.map((x, i) => {
            const start = i * seg;
            const mid = start + seg / 2;
            const fill = SEGMENT_FILLS[i % SEGMENT_FILLS.length];
            const dark = fill === "#f2b544" || fill === "#e5a83a";
            const label = x.name.length > 14 ? `${x.name.slice(0, 13)}…` : x.name;
            return (
              <g key={x.id} className={x.id === winnerId ? "segment is-winner" : "segment"}>
                {n === 1 ? (
                  <circle r={R} fill={fill} />
                ) : (
                  <path d={segmentPath(start, start + seg)} fill={fill} />
                )}
                {/* Names run from the hub out to the rim, like a real wheel. */}
                <g transform={`rotate(${mid - 90})`}>
                  <text
                    x={R - 18}
                    y={fontSize * 0.36}
                    textAnchor="end"
                    className="segment__label"
                    fontSize={fontSize}
                    fill={dark ? "#10241e" : "#fbfaf5"}
                  >
                    {label} {x.emoji}
                  </text>
                </g>
              </g>
            );
          })}
          {names.map((_, i) => {
            const [x, y] = polar(i * seg, R);
            return <line key={`div-${i}`} x1={0} y1={0} x2={x} y2={y} className="segment__divider" />;
          })}
        </g>
        <circle r={R} className="wheel__edge" />
        <circle r={50} className="wheel__hub" />
        <text y={17} textAnchor="middle" fontSize={44} aria-hidden>
          🎄
        </text>
        <path d={`M-22 ${-RIM - 30} L22 ${-RIM - 30} L0 ${-R + 14} Z`} className="wheel__pointer" />
      </svg>
    </div>
  );
}
