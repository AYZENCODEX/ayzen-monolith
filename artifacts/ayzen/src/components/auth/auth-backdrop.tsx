import { useEffect, useRef } from "react";

/**
 * Animated background for the sign-in portal: the AYZEN modules as a slowly
 * turning constellation around the core, with data packets travelling the
 * spokes. Canvas 2D, no dependencies.
 *
 * - Pauses when the tab is hidden or the canvas is off-screen.
 * - Renders a single still frame under prefers-reduced-motion.
 * - Pointer position tilts the scene a few degrees (parallax); it never
 *   drives layout or reads from the form.
 */

export interface BackdropNode {
  key: string;
  color: string; // #rrggbb
}

interface Props {
  nodes: BackdropNode[];
  /** 0..1, where the constellation centre sits horizontally on wide screens. */
  anchorX?: number;
  className?: string;
}

interface P3 { x: number; y: number; z: number }
interface Packet { spoke: number; t: number; speed: number; dir: 1 | -1 }
interface Dust { x: number; y: number; z: number; s: number }

const TAU = Math.PI * 2;
const CORE = "#EAF2FF";

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function glowSprite(hex: string): HTMLCanvasElement {
  const size = 96;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgba(hex, 0.95));
  grad.addColorStop(0.18, rgba(hex, 0.55));
  grad.addColorStop(1, rgba(hex, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export function AuthBackdrop({ nodes, anchorX = 0.36, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sprites = new Map<string, HTMLCanvasElement>();
    const sprite = (hex: string) => {
      let s = sprites.get(hex);
      if (!s) { s = glowSprite(hex); sprites.set(hex, s); }
      return s;
    };

    // Modules sit on a tilted ring, alternating above/below the plane.
    const n = nodes.length;
    const base: P3[] = nodes.map((_, i) => {
      const a = (i / n) * TAU;
      return { x: Math.cos(a), y: (i % 2 ? 0.34 : -0.34) + Math.sin(a * 2) * 0.1, z: Math.sin(a) };
    });
    const packets: Packet[] = [];
    const spawn = () => {
      packets.push({ spoke: Math.floor(Math.random() * n), t: 0, speed: 0.12 + Math.random() * 0.16, dir: Math.random() < 0.5 ? 1 : -1 });
    };
    for (let i = 0; i < 5; i++) { spawn(); packets[i].t = Math.random(); }

    const dust: Dust[] = Array.from({ length: 70 }, () => ({
      x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random(), s: 0.4 + Math.random() * 1.1,
    }));

    let w = 0, h = 0, dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => {
      pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };

    let raf = 0, last = 0, spin = 0.6, running = false, onScreen = true;

    const frame = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      if (!reduce) {
        spin += dt * 0.09;
        pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 3);
        pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 3);
      }
      draw(spin + pointer.x * 0.12, pointer.y * 0.08, dt);
      if (running) raf = requestAnimationFrame(frame);
    };

    const draw = (yaw: number, tilt: number, dt: number) => {
      ctx.clearRect(0, 0, w, h);
      const wide = w >= 900;
      const cx = wide ? w * anchorX : w * 0.5;
      const cy = h * (wide ? 0.38 : 0.21);
      const R = wide ? Math.min(w * 0.24, h * 0.27) : Math.min(w * 0.34, h * 0.13);
      const persp = 3.2;

      // dust (parallax by depth)
      ctx.fillStyle = "rgba(234,242,255,.5)";
      for (const d of dust) {
        const drift = reduce ? 0 : dt * 0.004 * (0.4 + d.z);
        d.y -= drift; if (d.y < -1.05) d.y = 1.05;
        const px = w * 0.5 + (d.x + pointer.x * 0.03 * d.z) * w * 0.52;
        const py = h * 0.5 + d.y * h * 0.52;
        ctx.globalAlpha = 0.1 + d.z * 0.35;
        ctx.fillRect(px, py, d.s, d.s);
      }
      ctx.globalAlpha = 1;

      const cosY = Math.cos(yaw), sinY = Math.sin(yaw), cosX = Math.cos(0.42 + tilt), sinX = Math.sin(0.42 + tilt);
      const proj = base.map((p) => {
        const x1 = p.x * cosY - p.z * sinY, z1 = p.x * sinY + p.z * cosY;
        const y2 = p.y * cosX - z1 * sinX, z2 = p.y * sinX + z1 * cosX;
        const k = persp / (persp + z2);
        return { sx: cx + x1 * R * k, sy: cy + y2 * R * k, k, z: z2 };
      });

      // ring + spokes
      ctx.lineWidth = 1;
      for (let i = 0; i < n; i++) {
        const a = proj[i], b = proj[(i + 1) % n];
        ctx.strokeStyle = "rgba(234,242,255,.07)";
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
        const g = ctx.createLinearGradient(cx, cy, a.sx, a.sy);
        g.addColorStop(0, "rgba(234,242,255,.22)");
        g.addColorStop(1, rgba(nodes[i].color, 0.16 + (1 - (a.z + 1) / 2) * 0.1));
        ctx.strokeStyle = g;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(a.sx, a.sy); ctx.stroke();
      }

      // packets
      if (!reduce) {
        for (let i = packets.length - 1; i >= 0; i--) {
          const p = packets[i];
          p.t += dt * p.speed;
          if (p.t >= 1) { packets.splice(i, 1); spawn(); continue; }
        }
      }
      for (const p of packets) {
        const a = proj[p.spoke];
        const t = p.dir === 1 ? p.t : 1 - p.t;
        const x = cx + (a.sx - cx) * t, y = cy + (a.sy - cy) * t;
        const s = sprite(nodes[p.spoke].color);
        ctx.globalAlpha = Math.sin(p.t * Math.PI);
        ctx.drawImage(s, x - 9, y - 9, 18, 18);
      }
      ctx.globalAlpha = 1;

      // core
      const pulse = reduce ? 1 : 1 + Math.sin(performance.now() / 900) * 0.06;
      ctx.drawImage(sprite(CORE), cx - 34 * pulse, cy - 34 * pulse, 68 * pulse, 68 * pulse);
      ctx.fillStyle = CORE; ctx.beginPath(); ctx.arc(cx, cy, 3.4, 0, TAU); ctx.fill();

      // nodes, far to near
      const order = proj.map((_, i) => i).sort((i, j) => proj[j].z - proj[i].z);
      ctx.font = "500 11px 'JetBrains Mono', ui-monospace, monospace";
      ctx.textBaseline = "middle";
      for (const i of order) {
        const p = proj[i];
        const depth = 1 - (p.z + 1) / 2; // 0 far .. 1 near
        const size = 30 + depth * 26;
        ctx.globalAlpha = 0.45 + depth * 0.55;
        ctx.drawImage(sprite(nodes[i].color), p.sx - size / 2, p.sy - size / 2, size, size);
        ctx.fillStyle = nodes[i].color;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, 2.2 + depth * 2, 0, TAU); ctx.fill();
        ctx.fillStyle = "rgba(234,242,255,.78)";
        ctx.fillText(nodes[i].key, p.sx + 12 + depth * 4, p.sy);
      }
      ctx.globalAlpha = 1;
    };

    const start = () => {
      if (running || reduce || document.hidden || !onScreen) return;
      running = true; last = 0; raf = requestAnimationFrame(frame);
    };
    const stop = () => { running = false; cancelAnimationFrame(raf); };

    const ro = new ResizeObserver(() => { resize(); if (!running) draw(spin, 0, 0); });
    ro.observe(canvas);
    resize(); draw(spin, 0, 0);

    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; onScreen ? start() : stop(); });
    io.observe(canvas);
    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointermove", onMove, { passive: true });
    start();

    return () => {
      stop(); ro.disconnect(); io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
    };
  }, [nodes, anchorX]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
