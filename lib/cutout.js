// Fjerner den hvite bakgrunnen fra produktbilder, så bare selve varen står igjen.
// Fyller fra kantene og innover over nesten-hvite piksler; stopper ved produktet,
// så hvite felt inne i etiketten beholdes.
const sharp = require("sharp");

const SIZE = 512;
const NEAR_WHITE = 238;   // alle kanaler over dette regnes som bakgrunn
const MAX_TINT = 14;      // bakgrunnen er nøytral (ikke fargetonet)

function isBackground(data, i) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  return r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE &&
    Math.max(r, g, b) - Math.min(r, g, b) <= MAX_TINT;
}

async function cutout(input) {
  const { data, info } = await sharp(input)
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .flatten({ background: "#ffffff" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: w, height: h } = info;
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);

  while (stack.length) {
    const p = stack.pop();
    if (bg[p] || !isBackground(data, p * 4)) continue;
    bg[p] = 1;
    const x = p % w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (p >= w) stack.push(p - w);
    if (p < w * (h - 1)) stack.push(p + w);
  }

  // Gjennomsiktig bakgrunn, og halvgjennomsiktig kant mot bakgrunnen for myk overgang.
  let foreground = 0;
  for (let p = 0; p < w * h; p++) {
    if (bg[p]) { data[p * 4 + 3] = 0; continue; }
    foreground++;
    const x = p % w;
    const touchesBg = (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (p >= w && bg[p - w]) || (p < w * (h - 1) && bg[p + w]);
    if (touchesBg) data[p * 4 + 3] = 150;
  }

  // Bildet var ikke på hvit bakgrunn (eller produktet fylte alt): ingen utklipp.
  const share = foreground / (w * h);
  if (share > 0.97 || share < 0.02) return null;

  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .trim({ threshold: 1 })
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

module.exports = { cutout };
