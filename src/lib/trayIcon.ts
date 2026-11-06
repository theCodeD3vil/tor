// Draws the menubar icon with Canvas 2D: an icon (volume bars, arrows, the Tor logo, or
// nothing) followed by one or two values in Figtree. The backend sends what to show
// ("draw-tray-icon"), and gets a PNG back to put in the menubar ("setTrayIcon").
//
// Every digit sits in a fixed-width cell and the unit slot is sized for the widest unit
// of the current mode, so for a given setting the icon is always exactly the same width
// and the menubar item never jumps around.
import {
  BAR_COUNT,
  ICON_HEIGHT as H,
  MAX_BAR_H,
  barShapes,
  type BarShape,
  type Colors,
  type IconOptions,
  type Value,
} from "../../shared/trayIcon";
import { LOGO_PATH, LOGO_VIEWBOX } from "../../shared/logo";

const FONT = '"Figtree Variable"';
const DIGIT_WEIGHT = 600;
const UNIT_WEIGHT = 800;
const TEXT_COLOR = "#fff"; // text and logo: always white, whatever the menubar theme
const OFFLINE_RED = "#ff3b30"; // macOS system red

const PAD = 2;
const ICON_GAP = 6;
const BAR_W = 8;
const BAR_GAP = 3;
const BARS_W = BAR_COUNT * BAR_W + (BAR_COUNT - 1) * BAR_GAP;
const ARROW_W = 12;
const ARROW_GAP = 3;
const LOGO_SIZE = 28;
const DOT_SIZE = 20;

const SINGLE = { px: 26, baselines: [34] }; // 13pt; the slash's lowest ink is flush with the bars
const STACKED = { px: 20, baselines: [16, 34] };

// ── text ──
interface TextLayout {
  digitW: number;
  pointW: number;
  numberW: number; // "8.88": the widest a number gets
  spaceW: number;
  unitW: number; // the widest unit of the current mode
}

function textLayout(ctx: CanvasRenderingContext2D, px: number, units: string[]): TextLayout {
  const width = (s: string, weight: number): number => {
    ctx.font = `${weight} ${px}px ${FONT}`;
    return Math.ceil(ctx.measureText(s).width);
  };
  const digitW = Math.max(..."0123456789".split("").map((d) => width(d, DIGIT_WEIGHT)));
  const pointW = width(".", DIGIT_WEIGHT);
  return {
    digitW,
    pointW,
    numberW: 3 * digitW + pointW,
    spaceW: Math.round(px * 0.3),
    unitW: Math.max(...units.map((u) => width(u, UNIT_WEIGHT))),
  };
}

function drawValue(
  ctx: CanvasRenderingContext2D,
  t: TextLayout,
  px: number,
  value: Value,
  x: number,
  baseline: number,
): void {
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = `${DIGIT_WEIGHT} ${px}px ${FONT}`;
  let cx = x;
  for (const ch of value.num) {
    const cell = ch === "." ? t.pointW : t.digitW;
    ctx.textAlign = ch === "." ? "left" : "center"; // digits centered in their cell
    ctx.fillText(ch, Math.round(ch === "." ? cx : cx + cell / 2), baseline);
    cx += cell;
  }
  ctx.font = `${UNIT_WEIGHT} ${px}px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText(value.unit, x + t.numberW + t.spaceW, baseline); // fixed, even when "123" has no point
}

// ── icons ──
function drawBars(ctx: CanvasRenderingContext2D, shapes: BarShape[], colors: Colors): void {
  shapes.forEach(({ h, upH, on }, i) => {
    const x = PAD + i * (BAR_W + BAR_GAP);
    const top = H - h;
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.35;
    ctx.beginPath();
    ctx.roundRect(x, top, BAR_W, h, Math.min(BAR_W / 2, h / 2)); // pill-shaped ends
    ctx.clip();
    ctx.fillStyle = colors.down;
    ctx.fillRect(x, top, BAR_W, h);
    ctx.fillStyle = colors.up; // the top slice is the upload share
    ctx.fillRect(x, top, BAR_W, upH);
    ctx.restore();
  });
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, dir: "down" | "up", color: string) {
  const sign = dir === "down" ? 1 : -1;
  const cx = x + ARROW_W / 2;
  const tip = H / 2 + sign * 10;
  const headY = tip - sign * 5.5;
  ctx.beginPath();
  ctx.moveTo(cx, H / 2 - sign * 10); // shaft
  ctx.lineTo(cx, tip);
  ctx.moveTo(cx - 5, headY); // head
  ctx.lineTo(cx, tip);
  ctx.lineTo(cx + 5, headY);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

function drawLogo(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.translate(PAD, Math.round((H - LOGO_SIZE) / 2));
  ctx.scale(LOGO_SIZE / LOGO_VIEWBOX, LOGO_SIZE / LOGO_VIEWBOX);
  ctx.fillStyle = TEXT_COLOR;
  ctx.fill(new Path2D(LOGO_PATH));
  ctx.restore();
}

// offline, any icon but the bars becomes a red dot centered in the icon's slot (so the
// text does not move) and sitting on the bottom like the bars
function drawDot(ctx: CanvasRenderingContext2D, slotW: number): void {
  ctx.beginPath();
  ctx.arc(PAD + slotW / 2, H - DOT_SIZE / 2, DOT_SIZE / 2, 0, Math.PI * 2);
  ctx.fillStyle = OFFLINE_RED;
  ctx.fill();
}

const FULL_RED_BARS: BarShape[] = Array.from({ length: BAR_COUNT }, () => ({
  h: MAX_BAR_H,
  upH: 0,
  on: true,
}));

function iconWidth({ icon, arrows, offline }: IconOptions): number {
  const own = {
    bars: BARS_W,
    arrows: arrows.length * ARROW_W + (arrows.length - 1) * ARROW_GAP,
    logo: LOGO_SIZE,
    none: 0,
  }[icon];
  return offline ? own || DOT_SIZE : own; // "none" gets a slot of its own for the dot
}

function draw(options: IconOptions): HTMLCanvasElement {
  const { icon, values, units, colors, offline } = options;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const text = values.length > 1 ? STACKED : SINGLE;
  const layout = textLayout(ctx, text.px, units);
  const iconW = iconWidth(options);
  const textX = PAD + (iconW ? iconW + ICON_GAP : 0);

  canvas.width = textX + layout.numberW + layout.spaceW + layout.unitW + PAD;
  canvas.height = H; // resizing resets the context, so the drawing starts here

  if (offline && icon === "bars")
    drawBars(ctx, FULL_RED_BARS, { down: OFFLINE_RED, up: OFFLINE_RED });
  else if (offline) drawDot(ctx, iconW);
  else if (icon === "bars") drawBars(ctx, barShapes(options.bars), colors);
  else if (icon === "arrows") {
    options.arrows.forEach((dir, i) =>
      drawArrow(ctx, PAD + i * (ARROW_W + ARROW_GAP), dir, colors[dir]),
    );
  } else if (icon === "logo") drawLogo(ctx);

  values.forEach((v, i) => drawValue(ctx, layout, text.px, v, textX, text.baselines[i]));
  return canvas;
}

// ── PNG ──
// A 144 dpi pHYs chunk: it makes macOS treat the 36 px image as an 18 pt @2x icon. It is
// always the same 21 bytes (length, "pHYs", 5669 px/m twice, unit = metre, CRC).
const PHYS_144_DPI = new Uint8Array([
  0, 0, 0, 9, 0x70, 0x48, 0x59, 0x73, 0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1, 0x49, 0x52, 0x24, 0xf0,
]);
const AFTER_IHDR = 33; // 8-byte signature + 25-byte IHDR chunk

async function toPngBase64(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas: no PNG"))), "image/png"),
  );
  const png = new Blob([blob.slice(0, AFTER_IHDR), PHYS_144_DPI, blob.slice(AFTER_IHDR)]);
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(png);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

// ── wiring ──
export async function renderTrayIcon(options: IconOptions): Promise<string> {
  return toPngBase64(draw(options));
}

/** draws whatever the backend asks for, one icon at a time and in order */
export function startTrayIconRenderer(): void {
  const tiny = window.tiny;
  if (!tiny) return;
  let queue = Promise.all([
    document.fonts.load(`${DIGIT_WEIGHT} 20px ${FONT}`),
    document.fonts.load(`${UNIT_WEIGHT} 20px ${FONT}`),
  ]).then(() => {});
  tiny.api.on("draw-tray-icon", (options: IconOptions) => {
    queue = queue
      .then(async () => tiny.api.call("setTrayIcon", { png: await renderTrayIcon(options) }))
      .catch((err) => console.error("tray icon:", err));
  });
  // a fresh page (launch, reload) has drawn nothing yet: ask for the current icon
  void queue.then(() => tiny.api.call("trayIconReady"));
}
