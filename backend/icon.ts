// Renders the menubar icon to a PNG, dependency-free. It is an icon (volume bars, arrows,
// the Tor logo, or nothing) followed by one or two values drawn in Figtree (outlines in
// glyphs.ts). Every glyph sits in a fixed cell, so for a given setting the icon is
// always exactly the same width and the menubar item never jumps around.
import type { Traffic } from "../shared/types";
import type { MenubarIcon } from "../shared/settings";
import { BOLD_GLYPHS, GLYPHS, UNITS_PER_EM, type PathCommand } from "./glyphs";
import { LOGO_PATH, LOGO_VIEWBOX } from "../shared/logo";

export type RGB = [number, number, number];

const WHITE: RGB = [255, 255, 255]; // text and logo: always white, whatever the menubar theme

const HEIGHT = 36; // px, drawn @2x → 18pt
const PAD = 2;
const ICON_GAP = 6;

// ── canvas ──
interface Canvas {
  w: number;
  h: number;
  data: Uint8Array;
}

function blend(c: Canvas, px: number, py: number, color: RGB, a: number): void {
  if (a <= 0 || px < 0 || px >= c.w || py < 0 || py >= c.h) return;
  const i = (py * c.w + px) * 4;
  const dstA = c.data[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  for (let k = 0; k < 3; k++) {
    c.data[i + k] = Math.round((color[k] * a + c.data[i + k] * dstA * (1 - a)) / outA);
  }
  c.data[i + 3] = Math.round(outA * 255);
}

// ── outline rasterizer: closed contours → anti-aliased coverage (scanline, 4× vertical) ──
type Point = [number, number];
const SUB = 4;

interface Raster {
  ox: number;
  oy: number;
  w: number;
  h: number;
  data: Float32Array;
}

function rasterize(contours: Point[][]): Raster {
  const edges: [number, number, number, number][] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const pts of contours) {
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x0);
      minY = Math.min(minY, y0);
      maxY = Math.max(maxY, y0);
      if (y0 !== y1) edges.push([x0, y0, x1, y1]);
    }
  }
  const ox = Math.floor(minX) - 1;
  const oy = Math.floor(minY) - 1;
  const w = Math.ceil(maxX) + 1 - ox;
  const h = Math.ceil(maxY) + 1 - oy;
  const data = new Float32Array(Math.max(w * h, 0));
  for (let sy = 0; sy < h * SUB; sy++) {
    const y = oy + (sy + 0.5) / SUB;
    const hits: [number, number][] = [];
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
        hits.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
      }
    }
    hits.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    for (let i = 0; i < hits.length - 1; i++) {
      wind += hits[i][1];
      if (wind === 0) continue; // nonzero fill: span [hits[i], hits[i+1]]
      const from = hits[i][0] - ox;
      const to = hits[i + 1][0] - ox;
      for (let px = Math.floor(from); px < Math.ceil(to) && px < w; px++) {
        data[Math.floor(sy / SUB) * w + px] += (Math.min(to, px + 1) - Math.max(from, px)) / SUB;
      }
    }
  }
  return { ox, oy, w, h, data };
}

function drawRaster(c: Canvas, r: Raster, x: number, y: number, color: RGB, alpha = 1): void {
  for (let gy = 0; gy < r.h; gy++) {
    for (let gx = 0; gx < r.w; gx++) {
      blend(c, x + r.ox + gx, y + r.oy + gy, color, Math.min(r.data[gy * r.w + gx], 1) * alpha);
    }
  }
}

// font outlines: font units → pixels at a font size
function flattenGlyph(path: PathCommand[], em: number): Point[][] {
  const contours: Point[][] = [];
  let cur: Point[] = [];
  let x = 0;
  let y = 0;
  for (const [type, ...n] of path) {
    if (type === "M") {
      cur = [[n[0] * em, n[1] * em]];
      contours.push(cur);
      [x, y] = [n[0], n[1]];
    } else if (type === "L") {
      cur.push([n[0] * em, n[1] * em]);
      [x, y] = [n[0], n[1]];
    } else if (type === "Q") {
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        cur.push([
          (u * u * x + 2 * u * t * n[0] + t * t * n[2]) * em,
          (u * u * y + 2 * u * t * n[1] + t * t * n[3]) * em,
        ]);
      }
      [x, y] = [n[2], n[3]];
    } else if (type === "C") {
      for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        const u = 1 - t;
        cur.push([
          (u ** 3 * x + 3 * u * u * t * n[0] + 3 * u * t * t * n[2] + t ** 3 * n[4]) * em,
          (u ** 3 * y + 3 * u * u * t * n[1] + 3 * u * t * t * n[3] + t ** 3 * n[5]) * em,
        ]);
      }
      [x, y] = [n[4], n[5]];
    }
  }
  return contours;
}

const glyphCache = new Map<string, Raster>();
function glyphRaster(ch: string, bold: boolean, px: number): Raster {
  const key = `${bold ? "b" : "r"}${px}${ch}`;
  let r = glyphCache.get(key);
  if (!r) {
    r = rasterize(flattenGlyph((bold ? BOLD_GLYPHS : GLYPHS)[ch].path, px / UNITS_PER_EM));
    glyphCache.set(key, r);
  }
  return r;
}

// SVG path (M L H V C Z, absolute and relative) → flattened closed contours, scaled
function flattenSvgPath(d: string, scale: number): Point[][] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const contours: Point[][] = [];
  let cur: Point[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let i = 0;
  let cmd = "";
  const num = (): number => Number(tokens[i++]);
  const add = (px: number, py: number): void => {
    cur.push([px * scale, py * scale]);
    x = px;
    y = py;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        const px = ox + num();
        const py = oy + num();
        cur = [];
        contours.push(cur);
        add(px, py);
        startX = px;
        startY = py;
        cmd = rel ? "l" : "L"; // extra pairs after a move are line-tos
        break;
      }
      case "L":
        add(ox + num(), oy + num());
        break;
      case "H":
        add(ox + num(), y);
        break;
      case "V":
        add(x, oy + num());
        break;
      case "C": {
        const [x1, y1, x2, y2, x3, y3] = [
          ox + num(),
          oy + num(),
          ox + num(),
          oy + num(),
          ox + num(),
          oy + num(),
        ];
        const [x0, y0] = [x, y];
        for (let s = 1; s <= 12; s++) {
          const t = s / 12;
          const u = 1 - t;
          cur.push([
            (u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3) * scale,
            (u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3) * scale,
          ]);
        }
        x = x3;
        y = y3;
        break;
      }
      case "Z":
        x = startX;
        y = startY;
        break;
      default:
        i++; // unknown command: skip it
    }
  }
  return contours;
}

// ── text ──
const adv = (ch: string, bold: boolean, px: number): number =>
  (bold ? BOLD_GLYPHS : GLYPHS)[ch].adv * px;

interface TextMetrics {
  px: number;
  digitW: number;
  pointW: number;
  numberW: number;
  spaceW: number;
}

function textMetrics(px: number): TextMetrics {
  const digitW = Math.ceil(Math.max(..."0123456789".split("").map((c) => adv(c, false, px))));
  const pointW = Math.ceil(adv(".", false, px));
  return { px, digitW, pointW, numberW: 3 * digitW + pointW, spaceW: Math.round(px * 0.3) };
}

const unitWidth = (unit: string, px: number): number =>
  unit.split("").reduce((n, ch) => n + Math.ceil(adv(ch, true, px)), 0);

/** every unit that can appear in one value slot — the slot is sized for the widest */
function blockWidth(m: TextMetrics, units: string[]): number {
  return m.numberW + m.spaceW + Math.max(...units.map((u) => unitWidth(u, m.px)));
}

function drawValue(c: Canvas, m: TextMetrics, value: Value, x: number, baseline: number): void {
  let cx = x;
  for (const ch of value.num) {
    if (ch === ".") {
      drawRaster(c, glyphRaster(ch, false, m.px), Math.round(cx), baseline, WHITE);
      cx += m.pointW;
    } else {
      drawRaster(
        c,
        glyphRaster(ch, false, m.px),
        Math.round(cx + (m.digitW - adv(ch, false, m.px)) / 2),
        baseline,
        WHITE,
      );
      cx += m.digitW;
    }
  }
  cx = x + m.numberW + m.spaceW; // fixed, even when "123" has no point
  for (const ch of value.unit) {
    drawRaster(c, glyphRaster(ch, true, m.px), Math.round(cx), baseline, WHITE);
    cx += Math.ceil(adv(ch, true, m.px));
  }
}

// ── icons ──
const BAR_W = 8;
const BAR_GAP = 3;
const BAR_COUNT = 5;
const BARS_W = BAR_COUNT * BAR_W + (BAR_COUNT - 1) * BAR_GAP; // 52
const MAX_BAR_H = HEIGHT - 2;
const MIN_BAR_H = 3;
const PEAK_FLOOR = 50_000_000; // bytes: below this a bucket never fills the bar

function drawBars(c: Canvas, x: number, bars: Traffic[], colors: Colors): void {
  const peak = Math.max(...bars.map((b) => b.down + b.up), PEAK_FLOOR); // idle stays small
  bars.forEach((bar, i) => {
    const total = bar.down + bar.up;
    const h = Math.max(MIN_BAR_H, Math.round(Math.sqrt(total / peak) * MAX_BAR_H));
    const upH = total > 0 ? Math.round(h * (bar.up / total)) : 0;
    const x0 = x + i * (BAR_W + BAR_GAP);
    const yTop = HEIGHT - h;
    const radius = Math.min(BAR_W / 2, h / 2); // pill-shaped ends
    const cx = x0 + BAR_W / 2;
    const cy = yTop + h / 2;
    const alpha = total > 0 ? 1 : 0.35;
    for (let py = yTop - 1; py < HEIGHT; py++) {
      for (let px = x0 - 1; px < x0 + BAR_W + 1; px++) {
        // signed distance to the rounded rect → anti-aliased coverage
        const qx = Math.abs(px + 0.5 - cx) - (BAR_W / 2 - radius);
        const qy = Math.abs(py + 0.5 - cy) - (h / 2 - radius);
        const dist =
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
        const coverage = Math.min(Math.max(0.5 - dist, 0), 1);
        blend(c, px, py, py < yTop + upH ? colors.up : colors.down, coverage * alpha); // top slice = upload
      }
    }
  });
}

const ARROW_W = 12;
const ARROW_GAP = 3;

// capsule-stroke arrow (anti-aliased via signed distance); dir 1 = down, -1 = up
function drawArrow(c: Canvas, x0: number, dir: 1 | -1, color: RGB): void {
  const cx = x0 + ARROW_W / 2;
  const mid = HEIGHT / 2;
  const tail = mid - dir * 10;
  const tip = mid + dir * 10;
  const segs: [number, number, number, number][] = [
    [cx, tail, cx, tip],
    [cx - 5, tip - dir * 5.5, cx, tip],
    [cx + 5, tip - dir * 5.5, cx, tip],
  ];
  const half = 1.5;
  for (let py = 0; py < HEIGHT; py++) {
    for (let px = x0 - 2; px < x0 + ARROW_W + 2; px++) {
      let d = Infinity;
      for (const [ax, ay, bx, by] of segs) {
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.min(
          Math.max(((px + 0.5 - ax) * dx + (py + 0.5 - ay) * dy) / (dx * dx + dy * dy), 0),
          1,
        );
        d = Math.min(d, Math.hypot(px + 0.5 - (ax + t * dx), py + 0.5 - (ay + t * dy)));
      }
      blend(c, px, py, color, Math.min(Math.max(half + 0.5 - d, 0), 1));
    }
  }
}

const LOGO_SIZE = 28;
let logoRaster: Raster | undefined;

function drawLogo(c: Canvas, x: number): void {
  logoRaster ??= rasterize(flattenSvgPath(LOGO_PATH, LOGO_SIZE / LOGO_VIEWBOX));
  drawRaster(c, logoRaster, x, Math.round((HEIGHT - LOGO_SIZE) / 2), WHITE);
}

// ── public ──
export interface Value {
  /** "9.49" | "10.9" | "123" — at most 3 digits */
  num: string;
  /** "KB/s" | "Mbps" | "GB" … */
  unit: string;
}

export interface Colors {
  down: RGB;
  up: RGB;
}

export interface IconOptions {
  icon: MenubarIcon;
  /** bytes per bucket, oldest → newest (for the bars) */
  bars: Traffic[];
  /** one value, or two (upload first) drawn stacked */
  values: Value[];
  /** which arrows to draw, for the arrows icon */
  arrows: ("down" | "up")[];
  /** every unit a value can take in the current mode (sizes the text slot) */
  units: string[];
  colors: Colors;
}

const SINGLE_PX = 26; // 13pt
const STACKED_PX = 20;
const SINGLE_BASELINE = 34; // text sits at the bottom, its lowest ink (the slash) flush with the bars
const STACKED_BASELINES = [16, 34];

/** the menubar icon as PNG bytes */
export function renderIcon({ icon, bars, values, arrows, units, colors }: IconOptions): Uint8Array {
  const stacked = values.length > 1;
  const m = textMetrics(stacked ? STACKED_PX : SINGLE_PX);

  const iconW =
    icon === "bars"
      ? BARS_W
      : icon === "arrows"
        ? arrows.length * ARROW_W + (arrows.length - 1) * ARROW_GAP
        : icon === "logo"
          ? LOGO_SIZE
          : 0;
  const textX = PAD + (iconW ? iconW + ICON_GAP : 0);
  const width = textX + blockWidth(m, units) + PAD;
  const canvas: Canvas = { w: width, h: HEIGHT, data: new Uint8Array(width * HEIGHT * 4) };

  if (icon === "bars") drawBars(canvas, PAD, bars, colors);
  else if (icon === "arrows") {
    arrows.forEach((dir, i) => {
      drawArrow(
        canvas,
        PAD + i * (ARROW_W + ARROW_GAP),
        dir === "down" ? 1 : -1,
        dir === "down" ? colors.down : colors.up,
      );
    });
  } else if (icon === "logo") drawLogo(canvas, PAD);

  values.forEach((v, i) => {
    drawValue(canvas, m, v, textX, stacked ? STACKED_BASELINES[i] : SINGLE_BASELINE);
  });
  return encodePng(canvas);
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const v of bytes) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function chunk(type: string, data: number[]): number[] {
  const typeBytes = type.split("").map((c) => c.charCodeAt(0));
  const body = Uint8Array.from([...typeBytes, ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

function encodePng(canvas: Canvas): Uint8Array {
  const { w: WIDTH, h: HEIGHT, data: rgba } = canvas;
  // raw scanlines, filter byte 0
  const raw = new Uint8Array(HEIGHT * (WIDTH * 4 + 1));
  for (let y = 0; y < HEIGHT; y++) {
    raw.set(rgba.subarray(y * WIDTH * 4, (y + 1) * WIDTH * 4), y * (WIDTH * 4 + 1) + 1);
  }
  // zlib stream of stored (uncompressed) deflate blocks
  const z = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.subarray(i, Math.min(i + 65535, raw.length));
    const last = i + 65535 >= raw.length ? 1 : 0;
    z.push(
      last,
      part.length & 255,
      part.length >> 8,
      ~part.length & 255,
      (~part.length >> 8) & 255,
    );
    for (const b of part) z.push(b);
  }
  z.push(...u32(adler32(raw)));
  const dpi = 5669; // 144 dpi → macOS treats the image as @2x
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk("IHDR", [...u32(WIDTH), ...u32(HEIGHT), 8, 6, 0, 0, 0]),
    ...chunk("pHYs", [...u32(dpi), ...u32(dpi), 1]),
    ...chunk("IDAT", z),
    ...chunk("IEND", []),
  ]);
}
