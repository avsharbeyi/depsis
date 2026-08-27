import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from './api.js';
import { TONES, toneRgb, type Tone } from './ui.js';

/**
 * The layer behind everything, plus the two tiny plots that sit on top of it.
 *
 * They live together because all three are canvas/SVG drawing rather than markup, and because all
 * three answer the same question: what does this appliance look like when it is idle? The galaxy
 * is the answer for the desktop, the sparkline for a load history, the ring for a fullness.
 */

/* ─── background ────────────────────────────────────────────────────────────── */

export interface BackgroundPreset {
  id: string;
  label: string;
  css: string;
}

/**
 * The ready-made gradients, carried over from the reference.
 *
 * `Preferences.background.preset` is a free string in the contract, so the id — not the Turkish
 * label — is what gets stored: renaming "Mor sis" tomorrow must not turn somebody's saved
 * background into an unknown one.
 */
const DEEP_BLUE = 'linear-gradient(160deg,#0A1A2E,#04294A 45%,#020A14)';

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { id: 'deep', label: 'Derin mavi', css: DEEP_BLUE },
  { id: 'mist', label: 'Mor sis', css: 'linear-gradient(150deg,#2A0F3A,#4A1A5E 40%,#0A0414)' },
  {
    id: 'aurora',
    label: 'Kuzey ışığı',
    css: 'linear-gradient(170deg,#02140E,#0A4A3A 45%,#021018)',
  },
];

/**
 * An unknown preset id resolves to the first gradient rather than to the galaxy.
 *
 * The user asked for `solid`; answering with the animated sky would be arguing with a preference
 * that was saved on purpose, and answering with nothing leaves the black screen this component
 * exists to prevent.
 */
function presetCss(id: string | undefined): string {
  if (id === undefined) return DEEP_BLUE;
  return BACKGROUND_PRESETS.find((p) => p.id === id)?.css ?? DEEP_BLUE;
}

/**
 * True while the user has asked the system to stop moving things.
 *
 * Read as state rather than once at module load because the setting can be flipped while the tab
 * is open, and a galaxy that keeps spinning after the user turned motion off is exactly the case
 * the preference exists for.
 */
function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState<boolean>(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (): void => setReduced(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

interface Star {
  /** Distance from the galactic centre, before the vertical squash. */
  r: number;
  /** Angle on the spiral at t=0. */
  a: number;
  /** Angular speed. Inner stars orbit faster, which is what makes the arms wind up. */
  w: number;
  size: number;
  alpha: number;
  /** Twinkle frequency and phase, so 4000 stars do not pulse in unison. */
  twinkle: number;
  phase: number;
  color: string;
}

const CORE_COLOR = 'rgb(255,232,196)';
const OUTER_COLORS = ['rgb(150,190,255)', 'rgb(255,178,168)', 'rgb(222,234,255)'] as const;

function buildStars(width: number, height: number, still: boolean): Star[] {
  const stars: Star[] = [];
  const reach = Math.hypot(width, height) * 0.62;
  const between = (a: number, b: number): number => a + Math.random() * (b - a);

  for (let i = 0; i < 4000; i += 1) {
    // The 0.62 exponent biases the draw towards the centre; a uniform radius gives an even disc,
    // which reads as noise rather than as a galaxy.
    const r = Math.pow(Math.random(), 0.62) * reach;
    const arm = Math.floor(Math.random() * 2) * Math.PI;
    const a =
      arm +
      2.9 * Math.log(1 + r / (reach * 0.16)) +
      (Math.random() - 0.5) * 0.34 * (1 + (r / reach) * 2.2);
    const core = r < reach * 0.16;
    const blue = Math.random() < 0.16;
    const pink = !blue && Math.random() < 0.1;
    stars.push({
      r,
      a,
      w: still ? 0 : 0.5 + 1.6 / (1 + r / (reach * 0.3)),
      size: core ? between(0.5, 1.5) : between(0.35, 1.25),
      alpha: core ? between(0.45, 0.95) : between(0.14, 0.68),
      twinkle: between(0.5, 2),
      phase: Math.random() * 7,
      color: core ? CORE_COLOR : blue ? OUTER_COLORS[0] : pink ? OUTER_COLORS[1] : OUTER_COLORS[2],
    });
  }
  return stars;
}

/**
 * The desktop background: a drawn galaxy, a flat gradient, or the user's own file.
 *
 * Only one of the three is ever mounted, so they can share the `#sky` rule — fixed, full-bleed,
 * behind everything. Mounting the canvas conditionally is also what stops the animation: an
 * unmounted canvas takes its effect cleanup with it, and the frame loop is cancelled there.
 */
export function Sky({
  mode,
  preset,
  fileId,
}: {
  mode: 'sky' | 'solid' | 'file';
  preset?: string;
  fileId?: string;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  // The contract hands over a file id and nothing else — not a MIME type — so the only way to
  // learn whether those bytes are a picture or a video is to try. Each failure steps down one
  // rung, and the last rung is the galaxy rather than a black rectangle: a background the user
  // chose and cannot see is indistinguishable from a broken appliance.
  const [attempt, setAttempt] = useState<'image' | 'video' | 'sky'>('image');
  useEffect(() => setAttempt('image'), [fileId]);

  const src =
    fileId !== undefined && fileId !== '' ? `${API_BASE_URL}/files/${fileId}/content` : null;
  const showFile = mode === 'file' && src !== null && attempt !== 'sky';
  const showGalaxy = mode === 'sky' || (mode === 'file' && !showFile);

  useEffect(() => {
    if (!showGalaxy) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) return;

    // Above 1.75 the extra pixels cost real frames on the little ARM boards this thing runs on and
    // buy nothing visible on 1px stars.
    const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const dpr = Math.min(ratio, 1.75);

    let width = 1;
    let height = 1;
    let stars: Star[] = [];
    let frame = 0;
    const start = performance.now();

    const paint = (now: number): void => {
      const t = (now - start) / 1000;
      const cx = width * 0.5;
      const cy = height * 0.46;
      const reach = Math.hypot(width, height) * 0.62;

      const ground = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(width, height) * 0.6);
      ground.addColorStop(0, '#0A1020');
      ground.addColorStop(0.45, '#060A14');
      ground.addColorStop(1, '#02040A');
      ctx.fillStyle = ground;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.translate(cx, cy);
      // A galaxy seen edge-on-ish. Squashing the whole disc is far cheaper than giving every star
      // its own inclination, and at this density nobody can tell the difference.
      ctx.scale(1, 0.42);
      ctx.globalCompositeOperation = 'lighter';

      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, reach * 0.3);
      core.addColorStop(0, 'rgba(255,236,200,.5)');
      core.addColorStop(0.28, 'rgba(255,206,150,.16)');
      core.addColorStop(1, 'rgba(255,190,130,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, reach * 0.3, 0, Math.PI * 2);
      ctx.fill();

      const halo = ctx.createRadialGradient(0, 0, reach * 0.1, 0, 0, reach);
      halo.addColorStop(0, 'rgba(120,150,230,.10)');
      halo.addColorStop(0.55, 'rgba(90,120,200,.05)');
      halo.addColorStop(1, 'rgba(60,90,170,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, reach, 0, Math.PI * 2);
      ctx.fill();

      for (const star of stars) {
        const a = star.a + t * star.w * 0.045;
        ctx.globalAlpha =
          star.alpha * (reduced ? 1 : 0.75 + 0.25 * Math.sin(t * star.twinkle + star.phase));
        ctx.fillStyle = star.color;
        ctx.fillRect(Math.cos(a) * star.r, Math.sin(a) * star.r, star.size, star.size);
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    };

    const measure = (): void => {
      const box = canvas.getBoundingClientRect();
      // No minimum width here on purpose: the reference clamped to 360x420 because it drew into a
      // fixed demo box, but this canvas is the viewport. Clamping a 320px phone up to 360 would
      // stretch the backing store across a narrower element and leave the galaxy off-centre.
      width = Math.max(1, box.width);
      height = Math.max(1, box.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = buildStars(width, height, reduced);
    };

    const loop = (now: number): void => {
      paint(now);
      frame = requestAnimationFrame(loop);
    };

    const observer = new ResizeObserver(() => {
      measure();
      // With motion reduced there is no loop to pick the new size up, so the one frame is redrawn
      // here or the canvas keeps showing the old geometry stretched.
      if (reduced) paint(start);
    });
    observer.observe(canvas);

    measure();
    if (reduced) paint(start);
    else frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [showGalaxy, reduced]);

  if (showGalaxy) return <canvas id="sky" ref={canvasRef} aria-hidden />;

  if (mode === 'solid') {
    return (
      <div
        id="sky"
        aria-hidden
        style={{
          background: presetCss(preset),
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
    );
  }

  if (src !== null && attempt === 'image') {
    return (
      <>
        <img
          id="sky"
          alt=""
          aria-hidden
          src={src}
          style={{ objectFit: 'cover' }}
          onError={() => setAttempt('video')}
        />
        {/* Sahada bulundu: parlak bir fotoğrafın üstünde cam pencere kromu ve sekme çizgisi
            kayboluyor — "tab incecik kalıyor". Tül fotoğrafı örtmez, kromun okunduğu üst ve alt
            bantları hafifçe karartır. Yalnız dosya kipinde: galaksi ve düz renkler zaten koyu. */}
        <div className="skyveil" aria-hidden />
      </>
    );
  }

  return (
    <video
      id="sky"
      aria-hidden
      src={src ?? ''}
      autoPlay
      muted
      loop
      playsInline
      style={{ objectFit: 'cover' }}
      onError={() => setAttempt('sky')}
    />
  );
}

/* ─── plots ─────────────────────────────────────────────────────────────────── */

/**
 * A load history, 32px tall, no axes.
 *
 * Nothing is drawn for fewer than two samples. A sparkline invented from a single reading is a
 * flat line that looks like a measurement, and the one place this appears — the system card, on
 * first load — is exactly where a reader would believe it.
 */
export function Spark({
  values,
  tone = 'rose',
}: {
  values: number[];
  tone?: Tone;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const dpr = Math.min(ratio, 1.75);
    const [r, g, b] = toneRgb(tone);
    const line = TONES[tone];
    const height = 32;

    const draw = (): void => {
      const width = Math.max(1, canvas.getBoundingClientRect().width);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (values.length < 2) return;

      // The series is a load average, which has no ceiling, so the plot scales to its own peak.
      // The floor of 1 keeps an idle machine drawn as a low flat line instead of blowing a
      // 0.02→0.04 wobble up to full height and implying the box is struggling.
      const peak = Math.max(1, ...values);
      const step = width / (values.length - 1);
      const y = (v: number): number =>
        height - 3 - Math.min(1, Math.max(0, v) / peak) * (height - 9);

      ctx.beginPath();
      ctx.moveTo(0, height);
      for (const [i, v] of values.entries()) ctx.lineTo(i * step, y(v));
      ctx.lineTo(width, height);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, height);
      fill.addColorStop(0, `rgba(${r},${g},${b},.4)`);
      fill.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.beginPath();
      for (const [i, v] of values.entries()) {
        if (i === 0) ctx.moveTo(0, y(v));
        else ctx.lineTo(i * step, y(v));
      }
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      const last = values[values.length - 1];
      if (last !== undefined) {
        ctx.beginPath();
        ctx.arc(width - 1, y(last), 2.2, 0, Math.PI * 2);
        ctx.fillStyle = line;
        ctx.fill();
      }
    };

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [values, tone]);

  return <canvas className="spark" ref={canvasRef} aria-hidden />;
}

/** Circumference of the r=20 track, so the dash pattern can be expressed as a fraction of it. */
const RING_LENGTH = 2 * Math.PI * 20;

/**
 * A fullness dial. Always paired with the same figure in text, so it is hidden from the reader —
 * a screen reader announcing "graphic" twice for one number is noise.
 */
export function Ring({ ratio, tone = 'cool' }: { ratio: number; tone?: Tone }): React.JSX.Element {
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return (
    <svg width="54" height="54" viewBox="0 0 54 54" aria-hidden>
      <circle cx="27" cy="27" r="20" fill="none" stroke="rgba(255,255,255,.13)" strokeWidth="7" />
      {/* Dropped entirely at zero rather than drawn with a zero-length dash: the round cap turns
          that into a visible dot, so an empty pool would read as a little bit full. */}
      {safe > 0 && (
        <circle
          cx="27"
          cy="27"
          r="20"
          fill="none"
          stroke={TONES[tone]}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${safe * RING_LENGTH} ${RING_LENGTH}`}
          transform="rotate(-90 27 27)"
        />
      )}
    </svg>
  );
}
