/**
 * Pulls the full design spec from the Figma REST API: exact fills, typography,
 * radii, effects and auto-layout metrics for every node in the target frames,
 * plus a PNG render of each frame for visual reference.
 *
 * The MCP server is capped on Figma's Starter plan; the REST API is not.
 *
 *   FIGMA_TOKEN=figd_xxx node scripts/figma-pull.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = process.env.FIGMA_TOKEN;
const FILE_KEY = process.env.FIGMA_FILE_KEY ?? "7BaV6bSuEmykedypfTQYUU";

if (!TOKEN) {
  console.error("Set FIGMA_TOKEN (Figma > Settings > Security > Personal access tokens)");
  process.exit(1);
}

const OUT = "design";
mkdirSync(OUT, { recursive: true });

const api = async (path) => {
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { "X-Figma-Token": TOKEN },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json();
};

/* ---------------- colour + style helpers ---------------- */

const hex = (c) => {
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
};

const paint = (p) => {
  if (!p || p.visible === false) return null;
  const opacity = p.opacity ?? 1;

  if (p.type === "SOLID") {
    const a = (p.color.a ?? 1) * opacity;
    return a < 1
      ? `rgba(${Math.round(p.color.r * 255)}, ${Math.round(p.color.g * 255)}, ${Math.round(p.color.b * 255)}, ${a.toFixed(3)})`
      : hex(p.color);
  }

  if (p.type?.startsWith("GRADIENT")) {
    const stops = (p.gradientStops ?? [])
      .map((s) => `${paint({ type: "SOLID", color: s.color })} ${Math.round(s.position * 100)}%`)
      .join(", ");
    const kind = p.type === "GRADIENT_RADIAL" ? "radial-gradient(circle" : "linear-gradient(180deg";
    return `${kind}, ${stops})`;
  }

  if (p.type === "IMAGE") return `image:${p.imageRef}`;
  return p.type;
};

const effect = (e) => {
  if (!e || e.visible === false) return null;
  const c = e.color ? paint({ type: "SOLID", color: e.color }) : "";
  const { x = 0, y = 0 } = e.offset ?? {};

  if (e.type === "DROP_SHADOW") return `${x}px ${y}px ${e.radius}px ${e.spread ?? 0}px ${c}`;
  if (e.type === "INNER_SHADOW") return `inset ${x}px ${y}px ${e.radius}px ${e.spread ?? 0}px ${c}`;
  if (e.type === "LAYER_BLUR") return `blur(${e.radius}px)`;
  if (e.type === "BACKGROUND_BLUR") return `backdrop-blur(${e.radius}px)`;
  return e.type;
};

const lineHeight = (s) => {
  if (s.lineHeightUnit === "PIXELS") return `${Math.round(s.lineHeightPx)}px`;
  if (s.lineHeightPercentFontSize) return `${Math.round(s.lineHeightPercentFontSize)}%`;
  return "normal";
};

/* ---------------- node walker ---------------- */

function describe(node, parentBox) {
  const box = node.absoluteBoundingBox;
  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (box) {
    out.w = Math.round(box.width);
    out.h = Math.round(box.height);
    // Position relative to the parent frame, which is what layout work needs.
    if (parentBox) {
      out.x = Math.round(box.x - parentBox.x);
      out.y = Math.round(box.y - parentBox.y);
    }
  }

  const fills = (node.fills ?? []).map(paint).filter(Boolean);
  if (fills.length) out.fill = fills.length === 1 ? fills[0] : fills;

  const strokes = (node.strokes ?? []).map(paint).filter(Boolean);
  if (strokes.length) {
    out.stroke = strokes.length === 1 ? strokes[0] : strokes;
    if (node.strokeWeight) out.strokeWidth = node.strokeWeight;
    if (node.strokeDashes?.length) out.strokeDashes = node.strokeDashes;
  }

  if (node.cornerRadius !== undefined) out.radius = node.cornerRadius;
  if (node.rectangleCornerRadii) out.radii = node.rectangleCornerRadii;

  const effects = (node.effects ?? []).map(effect).filter(Boolean);
  if (effects.length) out.effects = effects;

  if (node.opacity !== undefined && node.opacity !== 1) out.opacity = node.opacity;

  // Auto-layout: the numbers that translate straight into flex/gap/padding.
  if (node.layoutMode && node.layoutMode !== "NONE") {
    out.layout = {
      direction: node.layoutMode === "HORIZONTAL" ? "row" : "column",
      gap: node.itemSpacing ?? 0,
      padding: [
        node.paddingTop ?? 0,
        node.paddingRight ?? 0,
        node.paddingBottom ?? 0,
        node.paddingLeft ?? 0,
      ],
      align: node.counterAxisAlignItems,
      justify: node.primaryAxisAlignItems,
    };
  }

  if (node.type === "TEXT") {
    const s = node.style ?? {};
    out.text = node.characters;
    out.font = {
      family: s.fontFamily,
      size: s.fontSize,
      weight: s.fontWeight,
      lineHeight: lineHeight(s),
      letterSpacing: s.letterSpacing ? `${s.letterSpacing.toFixed(2)}px` : "0",
      align: s.textAlignHorizontal,
      case: s.textCase,
    };
  }

  const kids = (node.children ?? [])
    .filter((c) => c.visible !== false)
    .map((c) => describe(c, parentBox ?? box));
  if (kids.length) out.children = kids;

  return out;
}

/* ---------------- run ---------------- */

console.log(`Fetching file ${FILE_KEY}...`);
const file = await api(`/files/${FILE_KEY}?geometry=paths`);
console.log(`  "${file.name}", last modified ${file.lastModified}`);

// Collect the top-level frames from every page and section.
const frames = [];
const collect = (node) => {
  if (node.type === "FRAME" && node.absoluteBoundingBox) {
    frames.push(node);
    return;
  }
  for (const child of node.children ?? []) collect(child);
};
for (const page of file.document.children ?? []) collect(page);

console.log(`\n${frames.length} top-level frames:`);
for (const f of frames) {
  console.log(
    `  ${f.id.padEnd(10)} ${String(Math.round(f.absoluteBoundingBox.width)).padStart(5)}x${String(Math.round(f.absoluteBoundingBox.height)).padEnd(5)}  ${f.name}`,
  );
}

const spec = frames.map((f) => describe(f, null));
writeFileSync(join(OUT, "spec.json"), JSON.stringify(spec, null, 2));
console.log(`\nWrote ${OUT}/spec.json`);

// Every colour used, so the token palette can be built from real values.
const colours = new Map();
const walkColours = (n) => {
  for (const key of ["fill", "stroke"]) {
    const v = n[key];
    for (const c of Array.isArray(v) ? v : v ? [v] : []) {
      if (typeof c === "string" && (c.startsWith("#") || c.startsWith("rgba"))) {
        colours.set(c, (colours.get(c) ?? 0) + 1);
      }
    }
  }
  for (const k of n.children ?? []) walkColours(k);
};
spec.forEach(walkColours);

const palette = [...colours.entries()].sort((a, b) => b[1] - a[1]);
writeFileSync(join(OUT, "palette.json"), JSON.stringify(Object.fromEntries(palette), null, 2));
console.log(`\nPalette (${palette.length} colours, most used first):`);
for (const [c, n] of palette.slice(0, 28)) console.log(`  ${String(n).padStart(4)}x  ${c}`);

// Typography inventory.
const fonts = new Map();
const walkFonts = (n) => {
  if (n.font) {
    const key = `${n.font.family} ${n.font.weight} ${n.font.size}px/${n.font.lineHeight} ls:${n.font.letterSpacing}`;
    fonts.set(key, (fonts.get(key) ?? 0) + 1);
  }
  for (const k of n.children ?? []) walkFonts(k);
};
spec.forEach(walkFonts);

const typography = [...fonts.entries()].sort((a, b) => b[1] - a[1]);
writeFileSync(join(OUT, "typography.json"), JSON.stringify(Object.fromEntries(typography), null, 2));
console.log(`\nTypography (${typography.length} styles):`);
for (const [f, n] of typography) console.log(`  ${String(n).padStart(4)}x  ${f}`);

// Render each frame to PNG for visual reference.
const ids = frames.map((f) => f.id).join(",");
console.log(`\nRendering ${frames.length} frames to PNG...`);
const images = await api(`/images/${FILE_KEY}?ids=${encodeURIComponent(ids)}&format=png&scale=2`);

for (const frame of frames) {
  const url = images.images?.[frame.id];
  if (!url) {
    console.log(`  skip ${frame.name} (no render)`);
    continue;
  }
  const safe = frame.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const res = await fetch(url);
  writeFileSync(join(OUT, `${safe}.png`), Buffer.from(await res.arrayBuffer()));
  console.log(`  ${safe}.png`);
}

console.log(`\nDone. Spec, palette, typography and renders are in ${OUT}/`);
