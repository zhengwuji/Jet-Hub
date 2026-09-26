import { inflateSync, deflateSync } from 'node:zlib'

// CRC32 table
const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  crcTable[i] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePng(buf) {
  let offset = 8
  let width = 0
  let height = 0
  const idatParts = []

  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'IDAT') {
      idatParts.push(data)
    }
    offset += 12 + len
  }

  const decompressed = inflateSync(Buffer.concat(idatParts))
  const stride = width * 4
  const rgba = Buffer.alloc(width * height * 4)

  let srcPos = 0
  let prevRow = null

  for (let y = 0; y < height; y++) {
    const filter = decompressed[srcPos++]
    const currRow = Buffer.alloc(stride)

    for (let x = 0; x < stride; x++) {
      const val = decompressed[srcPos++]
      const left = x >= 4 ? currRow[x - 4] : 0
      const up = prevRow ? prevRow[x] : 0
      const upLeft = (prevRow && x >= 4) ? prevRow[x - 4] : 0

      let orig = val
      if (filter === 1) { // Sub
        orig = (val + left) & 0xff
      } else if (filter === 2) { // Up
        orig = (val + up) & 0xff
      } else if (filter === 3) { // Average
        orig = (val + Math.floor((left + up) / 2)) & 0xff
      } else if (filter === 4) { // Paeth
        orig = (val + paethPredictor(left, up, upLeft)) & 0xff
      }
      currRow[x] = orig
      rgba[y * stride + x] = orig
    }
    prevRow = currRow
  }

  return { width, height, rgba }
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = data.length
  const header = Buffer.alloc(4)
  header.writeUInt32BE(len, 0)
  const toCrc = Buffer.concat([typeBuf, data])
  const crcVal = crc32(toCrc)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crcVal, 0)
  return Buffer.concat([header, toCrc, crcBuf])
}

export function encodePng(rgba, width, height, filterType = 'paeth') {
  const stride = width * 4
  const filtered = Buffer.alloc(height * (stride + 1))
  let dstPos = 0

  let prevRow = null

  for (let y = 0; y < height; y++) {
    const currRow = rgba.subarray(y * stride, (y + 1) * stride)
    filtered[dstPos++] = 4 // Always use Paeth for compatibility with Cline icon
    for (let x = 0; x < stride; x++) {
      const val = currRow[x]
      const left = x >= 4 ? currRow[x - 4] : 0
      const up = prevRow ? prevRow[x] : 0
      const upLeft = (prevRow && x >= 4) ? prevRow[x - 4] : 0
      filtered[dstPos++] = (val - paethPredictor(left, up, upLeft)) & 0xff
    }
    prevRow = currRow
  }

  const idatData = deflateSync(filtered)
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // RGBA
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

export function resizeArea(srcRgba, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4)
  const xRatio = srcW / dstW
  const yRatio = srcH / dstH

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.floor(dx * xRatio)
      const sy = Math.floor(dy * yRatio)
      const srcIdx = (sy * srcW + sx) * 4
      const dstIdx = (dy * dstW + dx) * 4
      dst[dstIdx] = srcRgba[srcIdx]
      dst[dstIdx + 1] = srcRgba[srcIdx + 1]
      dst[dstIdx + 2] = srcRgba[srcIdx + 2]
      dst[dstIdx + 3] = srcRgba[srcIdx + 3]
    }
  }
  return dst
}
