'use strict';

// Generates build/icon.ico (and icon.png) with no external dependencies.
// Draws a rounded blurple tile with a white block "E", matching the in-app mark.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ACCENT = [88, 101, 242]; // #5865f2
const WHITE = [255, 255, 255];

function inRoundedRect(x, y, size) {
  const r = size * 0.22;
  const min = 0, max = size - 1;
  // distance into the nearest corner region
  const dx = x < min + r ? (min + r) - x : (x > max - r ? x - (max - r) : 0);
  const dy = y < min + r ? (min + r) - y : (y > max - r ? y - (max - r) : 0);
  return dx * dx + dy * dy <= r * r;
}

function inE(x, y, size) {
  const nx = x / size, ny = y / size;
  const vBar = nx >= 0.30 && nx <= 0.42 && ny >= 0.24 && ny <= 0.76;
  const top = nx >= 0.30 && nx <= 0.70 && ny >= 0.24 && ny <= 0.36;
  const mid = nx >= 0.30 && nx <= 0.64 && ny >= 0.45 && ny <= 0.55;
  const bot = nx >= 0.30 && nx <= 0.70 && ny >= 0.64 && ny <= 0.76;
  return vBar || top || mid || bot;
}

function drawRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundedRect(x, y, size)) {
        buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; // transparent
        continue;
      }
      const c = inE(x, y, size) ? WHITE : ACCENT;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
    }
  }
  return buf;
}

// ---- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO container (embeds PNGs) ------------------------------------------

function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           // reserved
  header.writeUInt16LE(1, 2);           // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  const datas = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size; // width  (0 means 256)
    e[1] = img.size >= 256 ? 0 : img.size; // height
    e[2] = 0;                              // palette
    e[3] = 0;                              // reserved
    e.writeUInt16LE(1, 4);                 // color planes
    e.writeUInt16LE(32, 6);                // bits per pixel
    e.writeUInt32LE(img.png.length, 8);    // size of PNG data
    e.writeUInt32LE(offset, 12);           // offset
    offset += img.png.length;
    entries.push(e);
    datas.push(img.png);
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

// ---- Build -----------------------------------------------------------------

const sizes = [256, 128, 64, 48, 32, 16];
const images = sizes.map((size) => ({ size, png: encodePNG(size, drawRGBA(size)) }));

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO(images));
fs.writeFileSync(path.join(outDir, 'icon.png'), images[0].png);
console.log(`Wrote icon.ico (${sizes.join(', ')}) and icon.png`);
