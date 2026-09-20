/**
 * png.mjs — đọc/ghi PNG thuần Node (chỉ dùng zlib có sẵn), không dependency.
 *
 * Vì sao tự viết: benchmark và test cần chạy trên KHUNG HÌNH THẬT lưu ra đĩa,
 * mà Node không có bộ giải mã ảnh. Kéo thêm thư viện là vi phạm ràng buộc "không
 * npm" của dự án, trong khi PNG 8-bit không interlace chỉ cần ~60 dòng.
 *
 * Chỉ hỗ trợ đúng thứ canvas.toDataURL() của Chrome xuất ra: 8-bit, RGB hoặc
 * RGBA, không interlace. Gặp định dạng khác thì ném lỗi rõ ràng thay vì đọc sai.
 */
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @returns {{width:number,height:number,data:Uint8ClampedArray}} RGBA */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Không phải file PNG');

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];

  for (let pos = 8; pos < buf.length; ) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`PNG không hỗ trợ: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8ClampedArray(width * height * 4);
  let prev = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0; // trái
      const b = prev[x]; // trên
      const c = x >= bpp ? prev[x - bpp] : 0; // trên-trái
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        // Paeth: chọn láng giềng gần nhất với ước lượng a + b - c.
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = (line[x] + add) & 255;
    }

    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * bpp];
      out[o + 1] = line[x * bpp + 1];
      out[o + 2] = line[x * bpp + 2];
      out[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }

  return { width, height, data: out };
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Ghi RGBA 8-bit ra PNG (filter 0 cho đơn giản — file to hơn chút nhưng đủ dùng). */
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Cắt một vùng và phóng to nguyên số nguyên (nearest) — dùng để soi chi tiết bằng mắt. */
export function cropScale(img, x, y, w, h, scale = 1) {
  const out = new Uint8ClampedArray(w * scale * h * scale * 4);
  for (let j = 0; j < h * scale; j++) {
    for (let i = 0; i < w * scale; i++) {
      const s = ((y + Math.floor(j / scale)) * img.width + (x + Math.floor(i / scale))) * 4;
      const d = (j * w * scale + i) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = 255;
    }
  }
  return { width: w * scale, height: h * scale, data: out };
}
