// Decode the .dds textures the ripper's texture script writes (DXT1, DXT3, DXT5 and plain 32/24-bit) to RGBA pixels.
// Pure functions on byte arrays, no DOM, so the app never needs a separate conversion step.

const DDS_MAGIC = 0x20534444;      // "DDS "
const fourCC = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
const DXT1 = fourCC('DXT1'), DXT3 = fourCC('DXT3'), DXT5 = fourCC('DXT5');

function colourTable(c0, c1, fourColour, out) {
  const r0 = ((c0 >> 11) & 31) * 255 / 31, g0 = ((c0 >> 5) & 63) * 255 / 63, b0 = (c0 & 31) * 255 / 31;
  const r1 = ((c1 >> 11) & 31) * 255 / 31, g1 = ((c1 >> 5) & 63) * 255 / 63, b1 = (c1 & 31) * 255 / 31;
  out[0] = r0; out[1] = g0; out[2] = b0; out[3] = 255;
  out[4] = r1; out[5] = g1; out[6] = b1; out[7] = 255;
  if (fourColour) {
    out[8] = (2 * r0 + r1) / 3; out[9] = (2 * g0 + g1) / 3; out[10] = (2 * b0 + b1) / 3; out[11] = 255;
    out[12] = (r0 + 2 * r1) / 3; out[13] = (g0 + 2 * g1) / 3; out[14] = (b0 + 2 * b1) / 3; out[15] = 255;
  } else {                                   // three colours plus transparent
    out[8] = (r0 + r1) / 2; out[9] = (g0 + g1) / 2; out[10] = (b0 + b1) / 2; out[11] = 255;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 0;
  }
}

/**
 * Decode a DDS file. Returns { width, height, data } where data is RGBA, 4 bytes per pixel, top row first.
 * Only the largest image in the file is read. Throws on formats the ripper does not produce.
 */
export function decodeDDS(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 128 || view.getUint32(0, true) !== DDS_MAGIC) throw new Error('Not a DDS file');
  const height = view.getUint32(12, true), width = view.getUint32(16, true);
  const pfFlags = view.getUint32(80, true), code = view.getUint32(84, true), bits = view.getUint32(88, true);
  if (!width || !height || width > 16384 || height > 16384) throw new Error('DDS has an unreasonable size');
  const out = new Uint8Array(width * height * 4);
  let p = 128;

  if (pfFlags & 0x4) {                                   // block-compressed
    if (code !== DXT1 && code !== DXT3 && code !== DXT5) throw new Error('Unsupported DDS compression');
    const blockBytes = code === DXT1 ? 8 : 16;
    const bw = Math.max(1, (width + 3) >> 2), bh = Math.max(1, (height + 3) >> 2);
    if (bytes.byteLength < 128 + bw * bh * blockBytes) throw new Error('DDS file is cut short');
    const table = new Float32Array(16), alpha = new Uint8Array(16), ramp = new Uint8Array(8);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        if (code === DXT3) {                             // 4 bits of alpha per pixel
          for (let i = 0; i < 16; i++) alpha[i] = ((bytes[p + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
          p += 8;
        } else if (code === DXT5) {                      // two alpha end points and a 3-bit index per pixel
          const a0 = bytes[p], a1 = bytes[p + 1];
          ramp[0] = a0; ramp[1] = a1;
          if (a0 > a1) { for (let i = 1; i < 7; i++) ramp[i + 1] = ((7 - i) * a0 + i * a1) / 7; }
          else { for (let i = 1; i < 5; i++) ramp[i + 1] = ((5 - i) * a0 + i * a1) / 5; ramp[6] = 0; ramp[7] = 255; }
          const lo = bytes[p + 2] | (bytes[p + 3] << 8) | (bytes[p + 4] << 16);
          const hi = bytes[p + 5] | (bytes[p + 6] << 8) | (bytes[p + 7] << 16);
          for (let i = 0; i < 8; i++) { alpha[i] = ramp[(lo >> (3 * i)) & 7]; alpha[i + 8] = ramp[(hi >> (3 * i)) & 7]; }
          p += 8;
        }
        const c0 = bytes[p] | (bytes[p + 1] << 8), c1 = bytes[p + 2] | (bytes[p + 3] << 8);
        colourTable(c0, c1, code !== DXT1 || c0 > c1, table);
        for (let i = 0; i < 16; i++) {
          const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
          if (x >= width || y >= height) continue;
          const k = ((bytes[p + 4 + (i >> 2)] >> ((i & 3) * 2)) & 3) * 4, o = (y * width + x) * 4;
          out[o] = table[k] + 0.5; out[o + 1] = table[k + 1] + 0.5; out[o + 2] = table[k + 2] + 0.5;
          out[o + 3] = code === DXT1 ? table[k + 3] : alpha[i];
        }
        p += 8;
      }
    }
  } else if (bits === 32 || bits === 24) {               // plain BGRA / BGR
    const step = bits / 8;
    if (bytes.byteLength < 128 + width * height * step) throw new Error('DDS file is cut short');
    for (let i = 0, o = 0; i < width * height; i++, o += 4, p += step) {
      out[o] = bytes[p + 2]; out[o + 1] = bytes[p + 1]; out[o + 2] = bytes[p];
      out[o + 3] = step === 4 ? bytes[p + 3] : 255;
    }
  } else {
    throw new Error('Unsupported DDS pixel format');
  }
  return { width, height, data: out };
}

/**
 * The game stores normal maps with X in the alpha channel and Y in green. Turn decoded pixels into a standard
 * tangent-space normal map (X, Y, Z in red, green, blue; green pointing up), in place.
 */
export function gameNormalToStandard(image) {
  const d = image.data;
  for (let o = 0; o < d.length; o += 4) {
    const x = d[o + 3] / 127.5 - 1, y = 1 - d[o + 1] / 127.5;      // flip Y to the convention three.js expects
    d[o] = d[o + 3];
    d[o + 1] = 255 - d[o + 1];
    d[o + 2] = 127.5 + 127.5 * Math.sqrt(Math.max(0, 1 - x * x - y * y));
    d[o + 3] = 255;
  }
  return image;
}

/** The game's specular maps carry glossiness in alpha. Turn decoded pixels into a roughness map (in green), in place. */
export function gameSpecToRoughness(image) {
  const d = image.data;
  for (let o = 0; o < d.length; o += 4) {
    const rough = 255 - Math.min(255, d[o + 3] * 1.15);
    d[o] = 255; d[o + 1] = rough; d[o + 2] = 0; d[o + 3] = 255;
  }
  return image;
}

/** Fraction of pixels that are fully transparent and fully opaque: tells a cut-out texture from one that is not. */
export function alphaProfile(image) {
  const d = image.data;
  let clear = 0, solid = 0;
  for (let o = 3; o < d.length; o += 4) { if (d[o] < 8) clear++; else if (d[o] > 247) solid++; }
  const n = d.length / 4;
  return { clear: clear / n, solid: solid / n };
}

/**
 * Paint a weapon camo onto decoded colour pixels, in place, the way the game's weapon materials do: the colour
 * map is a neutral base whose alpha says how strongly each spot takes paint, and the small camo pattern is tiled
 * across it and multiplied in (mid-grey leaves the base unchanged). Alpha is set to opaque afterwards.
 */
export function applyCamo(base, camo, repeats = 4) {
  const d = base.data, c = camo.data, cw = camo.width, ch = camo.height;
  for (let y = 0; y < base.height; y++) {
    const fy = ((y + 0.5) / base.height) * repeats * ch - 0.5;
    const y0 = Math.floor(fy), ty = fy - y0;
    const ya = ((y0 % ch) + ch) % ch, yb = (ya + 1) % ch;
    for (let x = 0; x < base.width; x++) {
      const fx = ((x + 0.5) / base.width) * repeats * cw - 0.5;
      const x0 = Math.floor(fx), tx = fx - x0;
      const xa = ((x0 % cw) + cw) % cw, xb = (xa + 1) % cw;
      const o = (y * base.width + x) * 4, mask = d[o + 3] / 255;
      const p00 = (ya * cw + xa) * 4, p10 = (ya * cw + xb) * 4, p01 = (yb * cw + xa) * 4, p11 = (yb * cw + xb) * 4;
      for (let k = 0; k < 3; k++) {
        const top = c[p00 + k] + (c[p10 + k] - c[p00 + k]) * tx, bottom = c[p01 + k] + (c[p11 + k] - c[p01 + k]) * tx;
        const paint = ((top + (bottom - top) * ty) / 255) * 2;                 // 1 means "leave the base as it is"
        d[o + k] = Math.min(255, d[o + k] * (1 + (paint - 1) * mask));
      }
      d[o + 3] = 255;
    }
  }
  return base;
}
