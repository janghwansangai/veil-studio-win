// Port of scripts/make-icon.swift: rasterizes the Veil icon and writes build/icon.png + build/icon.ico.
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'build')
fs.mkdirSync(out, { recursive: true })

// Designed on a 1024 canvas with a top-left origin (y flipped from the Core Graphics original).
const dots = [...Array(7).keys()].map(i => {
  const a = i * Math.PI / 3
  return { x: i === 6 ? 512 : 512 + Math.cos(a) * 226, y: i === 6 ? 512 : 1024 - (512 + Math.sin(a) * 226), color: i === 1 ? [179, 158, 255, 1] : [186, 235, 156, i === 6 ? 0.95 : 0.84] }
})
function insideRounded(x, y, x0, y0, size, r) {
  const cx = Math.min(Math.max(x, x0 + r), x0 + size - r), cy = Math.min(Math.max(y, y0 + r), y0 + size - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
function sample(x, y) {
  let c = [0, 0, 0, 0]
  const over = (src) => { const a = src[3], ia = 1 - a; c = [src[0] * a + c[0] * ia, src[1] * a + c[1] * ia, src[2] * a + c[2] * ia, a + c[3] * ia] }
  if (insideRounded(x, y, 55, 55, 914, 205)) {
    over([19, 22, 28, 1])
    if (!insideRounded(x, y, 59, 59, 906, 201)) over([255, 255, 255, 0.08])
  }
  for (const d of dots) if ((x - d.x) ** 2 + (y - d.y) ** 2 <= 102 * 102) over(d.color)
  return c
}
function render(size) {
  const n = 4, px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0]
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
      const s = sample((x + (sx + 0.5) / n) * 1024 / size, (y + (sy + 0.5) / n) * 1024 / size)
      acc = acc.map((v, i) => v + s[i])
    }
    const a = acc[3] / (n * n), o = (y * size + x) * 4
    px[o] = a ? Math.round(acc[0] / (n * n) / a) : 0; px[o + 1] = a ? Math.round(acc[1] / (n * n) / a) : 0; px[o + 2] = a ? Math.round(acc[2] / (n * n) / a) : 0; px[o + 3] = Math.round(a * 255)
  }
  return png(size, px)
}
function png(size, rgba) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body)); return Buffer.concat([len, body, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
const sizes = [256, 64, 48, 32, 24, 16], images = sizes.map(render)
fs.writeFileSync(path.join(out, 'icon.png'), render(512))
// ICO with PNG payloads (supported since Windows Vista).
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((s, i) => {
  const e = 6 + i * 16
  header[e] = s >= 256 ? 0 : s; header[e + 1] = s >= 256 ? 0 : s; header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6)
  header.writeUInt32LE(images[i].length, e + 8); header.writeUInt32LE(offset, e + 12); offset += images[i].length
})
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...images]))
console.log('icon written to', out)
