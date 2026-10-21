// Generates icon.iconset/ from icon-master-1024.png, applying Apple's macOS
// app-icon grid: the artwork is scaled into an 824x824 rounded rectangle
// (185.4px corner radius) centered on a transparent 1024x1024 canvas, with a
// subtle drop shadow — the shape Apple's HIG requires to be baked into the
// artwork. macOS 15 (Sequoia) and earlier render the .icns as-is, so a
// full-bleed square master would show square corners in the Dock there;
// macOS 26 (Tahoe) masks icons itself and treats a grid-compliant icon
// normally (no gray backing plate).
//
// Run: bun scripts/generate-iconset.ts   (from app/)
// The master stays full-bleed — edit it in Figma, re-export, re-run this.
import sharp from "sharp";

const SRC = "icon-master-1024.png";
const OUT = "icon.iconset";

// Apple app-icon grid @1024: 824x824 shape, 100px gutters, 185.4px radius.
const CANVAS = 1024;
const SHAPE = 824;
const MARGIN = (CANVAS - SHAPE) / 2;
const RADIUS = 185.4;

const roundedRect = (fill: string, offsetY = 0) =>
  `<rect x="${MARGIN}" y="${MARGIN + offsetY}" width="${SHAPE}" height="${SHAPE}" rx="${RADIUS}" fill="${fill}"/>`;

const svg = (body: string) =>
  Buffer.from(
    `<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
  );

// Artwork scaled to the shape size, masked to the rounded rectangle.
const art = await sharp(SRC)
  .resize(SHAPE, SHAPE)
  .extend({
    top: MARGIN,
    bottom: MARGIN,
    left: MARGIN,
    right: MARGIN,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .composite([{ input: svg(roundedRect("#fff")), blend: "dest-in" }])
  .png()
  .toBuffer();

// Soft drop shadow beneath the shape, per Apple's icon template.
const shadow = await sharp(svg(roundedRect("rgba(0,0,0,0.3)", 6)))
  .blur(8)
  .png()
  .toBuffer();

const master = await sharp({
  create: {
    width: CANVAS,
    height: CANVAS,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([{ input: shadow }, { input: art }])
  .png()
  .toBuffer();

for (const size of [16, 32, 128, 256, 512]) {
  await sharp(master)
    .resize(size, size)
    .png()
    .toFile(`${OUT}/icon_${size}x${size}.png`);
  await sharp(master)
    .resize(size * 2, size * 2)
    .png()
    .toFile(`${OUT}/icon_${size}x${size}@2x.png`);
}

console.log(`Regenerated ${OUT}/ from ${SRC}`);
