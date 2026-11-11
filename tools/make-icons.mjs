// 拡張機能のアイコン（赤い八角形に白い横棒）を icons/ に書き出す。外部のライブラリは使わない。
//   node tools/make-icons.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const RED = [229, 72, 77];
const WHITE = [255, 255, 255];
const SAMPLES = 4; // 1 ピクセルあたり 4×4 点で塗ってなめらかにする

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // ビット深度
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 中心を原点、半径 1 とした座標で判定する
const inOctagon = (u, v, a = 0.94) =>
  Math.abs(u) <= a && Math.abs(v) <= a && (Math.abs(u) + Math.abs(v)) / Math.SQRT2 <= a;
const inBar = (u, v) => Math.abs(u) <= 0.56 && Math.abs(v) <= 0.15;

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      const sum = [0, 0, 0];
      for (let j = 0; j < SAMPLES; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          const u = (x + (i + 0.5) / SAMPLES - half) / half;
          const v = (y + (j + 0.5) / SAMPLES - half) / half;
          if (!inOctagon(u, v)) continue;
          const color = inBar(u, v) ? WHITE : RED;
          covered++;
          for (let k = 0; k < 3; k++) sum[k] += color[k];
        }
      }
      const p = (y * size + x) * 4;
      if (covered) for (let k = 0; k < 3; k++) rgba[p + k] = Math.round(sum[k] / covered);
      rgba[p + 3] = Math.round((covered / SAMPLES ** 2) * 255);
    }
  }
  return encodePng(size, rgba);
}

const dir = new URL('../icons/', import.meta.url);
await mkdir(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(new URL(`icon${size}.png`, dir), draw(size));
  console.log(`icons/icon${size}.png`);
}
