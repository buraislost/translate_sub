/**
 * preprocess.js — biến khung hình phim thành ảnh "chữ đen nền trắng" cho OCR.
 *
 * Đây là phần kỹ thuật quyết định chất lượng: đo thật trên phim cho thấy
 * Tesseract đọc ảnh thô với CER 0,65 nhưng chỉ còn ~0,2 sau khi lọc — cùng
 * một engine, chỉ khác ảnh đầu vào.
 *
 * Ý tưởng chính — khai thác đặc thù của HARDSUB mà OCR tài liệu không có:
 *   chữ phụ đề là NÉT MẢNH, SÁNG, bọc VIỀN TỐI.
 *
 *   - "Mảnh": nét chữ rộng vài pixel. Vùng sáng rộng (bầu trời, tường trắng)
 *     thì không. White top-hat (ảnh trừ đi phép mở của nó) chỉ giữ lại cấu
 *     trúc sáng mảnh hơn cửa sổ — đúng là nét chữ, bất kể nền sáng hay tối.
 *   - "Viền tối": loại nốt sáng mảnh của tranh vẽ (vệt highlight, sợi tóc)
 *     vì chúng hiếm khi có viền đen liền kề.
 *
 * Toàn hàm thuần trên typed array, không đụng DOM/canvas → test được bằng
 * node:test và chạy được ở cả content script lẫn offscreen.
 */

/** @typedef {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} ImageLike */

/* ------------------------------------------------------------------ */
/* Nguyên liệu: độ sáng, histogram, Otsu                               */
/* ------------------------------------------------------------------ */

/** Độ sáng 0–255 theo công thức Rec.601, tính bằng số nguyên cho nhanh. */
export function lumaPlane(img) {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return out;
}

/** Histogram 256 mức xám. */
export function histogram(plane) {
  const h = new Uint32Array(256);
  for (let i = 0; i < plane.length; i++) h[plane[i]]++;
  return h;
}

/**
 * Ngưỡng Otsu — tự tìm ngưỡng tách hai lớp bằng cách cực đại hoá phương sai
 * GIỮA hai lớp (between-class variance). Bản chất là phân cụm 1 chiều thành
 * 2 cụm: không cần ngưỡng cố định, thích nghi theo từng ảnh.
 *
 * Duyệt 256 mức, với mỗi ngưỡng t chia histogram thành nền (≤ t) và chữ (> t):
 *   σ²_b(t) = w0(t) · w1(t) · (μ0(t) − μ1(t))²
 *
 * @param {ArrayLike<number>} hist histogram 256 mức
 * @returns {number} ngưỡng t ∈ [0,255]; pixel > t thuộc lớp sáng
 */
export function otsuThreshold(hist) {
  let total = 0;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sumAll += i * hist[i];
  }
  if (total === 0) return 127;

  let w0 = 0;
  let sum0 = 0;
  let best = 0;
  let bestVar = -1;

  for (let t = 0; t < 256; t++) {
    w0 += hist[t];
    if (w0 === 0) continue;
    const w1 = total - w0;
    if (w1 === 0) break;

    sum0 += t * hist[t];
    const mu0 = sum0 / w0;
    const mu1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (mu0 - mu1) * (mu0 - mu1);

    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Hình thái học trên ảnh xám                                          */
/* ------------------------------------------------------------------ */

/**
 * Lọc cực trị trượt 1 chiều, cửa sổ 2r+1. `pickMax` chọn max (dilate) hay min
 * (erode). Duyệt thẳng thay vì thuật toán van Herk vì r nhỏ (≤ 8): đơn giản
 * hơn, đủ nhanh cho vùng ảnh chỉ vài trăm nghìn pixel.
 */
function slide(src, dst, w, h, r, pickMax, horizontal) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 1 : w;
  const lineStep = horizontal ? w : 1;

  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    for (let i = 0; i < len; i++) {
      const lo = i - r < 0 ? 0 : i - r;
      const hi = i + r >= len ? len - 1 : i + r;
      let v = src[base + lo * step];
      if (pickMax) {
        for (let j = lo + 1; j <= hi; j++) {
          const s = src[base + j * step];
          if (s > v) v = s;
        }
      } else {
        for (let j = lo + 1; j <= hi; j++) {
          const s = src[base + j * step];
          if (s < v) v = s;
        }
      }
      dst[base + i * step] = v;
    }
  }
}

/** Erode/dilate hình vuông (2r+1)², tách thành hai lượt 1 chiều. */
export function morph(plane, w, h, r, pickMax) {
  if (r <= 0) return plane.slice();
  const tmp = new Uint8Array(plane.length);
  const out = new Uint8Array(plane.length);
  slide(plane, tmp, w, h, r, pickMax, true);
  slide(tmp, out, w, h, r, pickMax, false);
  return out;
}

/**
 * White top-hat: ảnh − phép mở(ảnh). Phép mở (erode rồi dilate) xoá mọi vùng
 * sáng hẹp hơn cửa sổ; phần bị xoá chính là cái top-hat giữ lại.
 * → Trả về "độ mảnh-sáng" của từng pixel: cao ở nét chữ, ~0 ở vùng sáng rộng.
 */
export function whiteTopHat(plane, w, h, r) {
  const opened = morph(morph(plane, w, h, r, false), w, h, r, true);
  const out = new Uint8Array(plane.length);
  for (let i = 0; i < out.length; i++) out[i] = plane[i] - opened[i];
  return out;
}

/* ------------------------------------------------------------------ */
/* Mặt nạ chữ                                                          */
/* ------------------------------------------------------------------ */

/**
 * Tham số mặc định, tính cho khung hình cao ~1080px. Mọi độ dài pixel đều nhân
 * với `scale` = chiều cao khung thực / 1080 — không hardcode theo độ phân giải,
 * vì đã gặp phim 1924×1040 và sẽ gặp 720p, 480p.
 */
export const DEFAULT_MASK_OPTS = {
  /** Nửa cửa sổ top-hat, ở 1080p. Phải lớn hơn NỬA bề rộng nét chữ (~4px). */
  hatRadius: 6,
  /** Ngưỡng top-hat: nét chữ phải sáng hơn vùng phẳng xung quanh ít nhất chừng này. */
  hatMin: 70,
  /** Độ sáng tối thiểu của ứng viên (bước lọc lỏng). */
  coreMin: 170,
  /** Tự đặt ngưỡng hạt giống theo phân vị 98 độ sáng của ứng viên. */
  seedAuto: true,
  /** Ngưỡng hạt giống khi tắt seedAuto. */
  seedMin: 240,
  /** Hạt giống thấp hơn phân vị 98 chừng này (dung sai do nén video). */
  seedMargin: 10,
  /** Chặn trên của ngưỡng hạt giống. */
  seedMax: 246,
  /** Nở từ hạt giống bao nhiêu px (ở 1080p). */
  seedGrow: 1,
  /** Pixel nở ra phải sáng ít nhất chừng này mới nhận. */
  edgeMin: 175,
  /** Độ sáng tối đa của viền. */
  edgeMax: 90,
  /**
   * Khoảng tìm viền tối quanh lõi chữ, ở 1080p. Đo thật (22 khung): 5 → CER 0,042;
   * 7 → 0,043; nhưng 7 kèm open=1 → 0,031. Nét chữ dày ~10px nên tâm nét cách viền
   * ~5px — bán kính 5 nằm đúng ranh giới, 7 có dư địa.
   */
  edgeRadius: 7,
  /**
   * Nở thêm sau cùng. Mặc định 0: đo thật cho thấy nở 1px làm các lỗ của o, ô, a
   * (chỉ rộng ~4px ở phông bold hẹp) bị lấp gần kín và Tesseract đọc thành khối đặc.
   */
  grow: 0,
  /**
   * Bán kính phép mở mặt nạ (đo thật: 22/22 khung ≤ 0,1 khi bật). Khe nền hẹp giữa hai viền đen cũng là "vệt sáng mảnh
   * kẹp giữa hai viền tối" nên lọt qua top-hat; phép mở xoá các vệt hẹp hơn nét chữ.
   */
  open: 1,
};

/**
 * Dựng mặt nạ chữ: 1 = pixel thuộc nét chữ, 0 = nền.
 *
 * @param {ImageLike} img
 * @param {Partial<typeof DEFAULT_MASK_OPTS> & {scale?: number}} opts
 * @returns {{mask: Uint8Array, width: number, height: number, count: number}}
 */
export function textMask(img, opts = {}) {
  const o = { ...DEFAULT_MASK_OPTS, ...opts };
  const s = o.scale ?? 1;
  const { width: w, height: h } = img;

  const rHat = Math.max(2, Math.round(o.hatRadius * s));
  const rEdge = Math.max(1, Math.round(o.edgeRadius * s));
  const rGrow = o.grow ? Math.max(1, Math.round(o.grow * s)) : 0;
  const rOpen = o.open ? Math.max(1, Math.round(o.open * s)) : 0;

  const luma = lumaPlane(img);
  const hat = whiteTopHat(luma, w, h, rHat);

  // Viền tối = pixel tối; "gần viền" = có pixel tối trong bán kính rEdge.
  // Dilate ảnh nhị phân bằng max trong cửa sổ.
  const darkness = new Uint8Array(luma.length);
  for (let i = 0; i < luma.length; i++) darkness[i] = luma[i] <= o.edgeMax ? 255 : 0;
  const nearDark = morph(darkness, w, h, rEdge, true);

  // Bước 1 — ứng viên lỏng: sáng mảnh, có viền tối kề bên.
  const cand = new Uint8Array(luma.length);
  const candHist = new Uint32Array(256);
  let nCand = 0;
  for (let i = 0; i < cand.length; i++) {
    if (hat[i] >= o.hatMin && luma[i] >= o.coreMin && nearDark[i]) {
      cand[i] = 1;
      candHist[luma[i]]++;
      nCand++;
    }
  }

  // Bước 2 — "hạt giống": chỉ lấy pixel THẬT SỰ TRẮNG. Đây là chỗ sửa lỗi lớn nhất:
  // khe giữa các nét và lỗ trong o, e, ơ (rộng ~4px, kẹp giữa hai viền đen) cũng là
  // "vệt sáng mảnh có viền tối", nên bước 1 tô kín chúng bằng màu nền — chữ đọc ra
  // thành khối đặc. Đo thật: chữ L=253–255, còn tường/bầu trời L=235–240. Độ trắng là
  // thứ duy nhất phân biệt được. Ngưỡng tự thích nghi theo phân vị 98 của chính các
  // ứng viên, nên chữ vàng hay chữ hơi xám (do nén) vẫn chạy.
  let seedMin = o.seedMin;
  if (o.seedAuto && nCand > 30) {
    let acc = 0;
    let p98 = 255;
    for (let v = 0; v < 256; v++) {
      acc += candHist[v];
      if (acc >= nCand * 0.98) {
        p98 = v;
        break;
      }
    }
    seedMin = Math.min(o.seedMax, Math.max(o.coreMin, p98 - o.seedMargin));
  }

  let mask = new Uint8Array(luma.length);
  for (let i = 0; i < mask.length; i++) {
    if (cand[i] && luma[i] >= seedMin) mask[i] = 1;
  }

  // Bước 3 — nở 1px từ hạt giống để lấy lại viền anti-alias của nét chữ. Nền tường
  // cách lõi chữ ≥ độ dày viền đen (~3px) nên không bị hút vào.
  const rSeed = Math.max(1, Math.round(o.seedGrow * s));
  const grown = morph(mask, w, h, rSeed, true);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && grown[i] && luma[i] >= o.edgeMin) mask[i] = 1;
  }

  if (rOpen > 0) mask = morph(morph(mask, w, h, rOpen, false), w, h, rOpen, true);
  if (rGrow > 0) mask = morph(mask, w, h, rGrow, true);

  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return { mask, width: w, height: h, count };
}

/* ------------------------------------------------------------------ */
/* Hình học: khung chữ, dòng                                           */
/* ------------------------------------------------------------------ */

/** Tổng số pixel chữ theo từng hàng / từng cột. */
export function projections(mask, w, h) {
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[base + x]) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  return { rows, cols };
}

/**
 * Tìm các dải hàng liên tiếp có chữ (mỗi dải ≈ một dòng phụ đề).
 * Ngưỡng theo tỉ lệ đỉnh để bỏ nhiễu rải rác; gộp các dải cách nhau ≤ `gap`
 * hàng, vì dấu thanh nằm cao hơn thân chữ và tạo khe hở giả trong một dòng.
 */
export function findLines(rows, { minFrac = 0.12, gap = 3, minHeight = 6 } = {}) {
  let peak = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i] > peak) peak = rows[i];
  if (peak === 0) return [];

  const cut = peak * minFrac;
  const runs = [];
  let start = -1;
  for (let y = 0; y <= rows.length; y++) {
    const on = y < rows.length && rows[y] > cut;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      runs.push({ top: start, bottom: y - 1 });
      start = -1;
    }
  }

  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.top - last.bottom <= gap) last.bottom = r.bottom;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.bottom - r.top + 1 >= minHeight);
}

/** Khung bao của mọi pixel chữ trong một dải hàng, hoặc null nếu trống. */
export function bboxInRows(mask, w, top, bottom) {
  let x0 = w;
  let x1 = -1;
  for (let y = top; y <= bottom; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[base + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  return x1 < 0 ? null : { x0, x1, y0: top, y1: bottom };
}

/* ------------------------------------------------------------------ */
/* Xuất ảnh cho OCR                                                    */
/* ------------------------------------------------------------------ */

/**
 * Mặt nạ → ảnh RGBA "chữ đen nền trắng" (Tesseract thích thế), có viền trắng
 * bao quanh: Tesseract đọc kém khi chữ chạm sát mép ảnh.
 */
export function maskToImage(mask, w, h, box, { pad = 12 } = {}) {
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const W = bw + pad * 2;
  const H = bh + pad * 2;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (mask[(box.y0 + y) * w + (box.x0 + x)]) {
        const o = ((y + pad) * W + (x + pad)) * 4;
        data[o] = data[o + 1] = data[o + 2] = 0;
      }
    }
  }
  return { data, width: W, height: H };
}

/* ------------------------------------------------------------------ */
/* Thành phần liên thông và chọn vùng chữ                              */
/* ------------------------------------------------------------------ */

/**
 * Gán nhãn thành phần liên thông (8 láng giềng) bằng loang có ngăn xếp tường
 * minh — đệ quy sẽ tràn stack trên thành phần vài chục nghìn pixel.
 *
 * @returns {{labels: Int32Array, comps: Array<{id:number,x0:number,x1:number,y0:number,y1:number,area:number}>}}
 */
export function components(mask, w, h, { minArea = 4 } = {}) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  let next = 1;

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;

    let sp = 0;
    stack[sp++] = i;
    labels[i] = next;
    let x0 = w, x1 = -1, y0 = h, y1 = -1, area = 0;

    while (sp) {
      const p = stack[--sp];
      const py = (p / w) | 0;
      const px = p - py * w;
      area++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = next;
            stack[sp++] = q;
          }
        }
      }
    }

    if (area >= minArea) comps.push({ id: next, x0, x1, y0, y1, area });
    next++;
  }
  return { labels, comps };
}

/**
 * Từ mật độ chữ theo từng hàng, chọn ra các dải hàng thuộc CÙNG MỘT phụ đề.
 *
 * Dùng chung cho tầng quét nhẹ (đếm pixel thô) lẫn tầng nặng (thành phần liên
 * thông) — hai tầng phải cùng một định nghĩa "dòng phụ đề", nếu không vùng cắt
 * của tầng nhẹ sẽ lệch với vùng đọc của tầng nặng.
 *
 * @param {ArrayLike<number>} rows mật độ chữ mỗi hàng
 * @param {number} h chiều cao ảnh
 * @param {{scale?: number}} opts scale = tỉ lệ so với độ phân giải gốc (quét nửa độ phân giải → 0,5)
 * @returns {{lines: Array<{top:number,bottom:number}>, lineHeight: number}|null}
 */
export function pickLineBands(rows, h, { scale = 1 } = {}) {
  const bands = findLines(rows, {
    minFrac: 0.1,
    gap: Math.max(1, Math.round(4 * scale)),
    minHeight: Math.max(3, Math.round(8 * scale)),
  });
  if (!bands.length) return null;

  const withMass = bands.map((b) => {
    let m = 0;
    for (let y = b.top; y <= b.bottom; y++) m += rows[y];
    return { ...b, mass: m };
  });
  const heaviest = withMass.reduce((a, b) => (b.mass > a.mass ? b : a));
  const lineHeight = heaviest.bottom - heaviest.top + 1;

  // Từ dải nặng nhất, mở rộng sang các dải kề nếu khe hở nhỏ hơn ~1 dòng và
  // đủ nặng — đó là dòng thứ hai của cùng một phụ đề. Dải xa hoặc nhẹ là nhiễu.
  const chosen = [heaviest];
  const sorted = [...withMass].sort((a, b) => a.top - b.top);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of sorted) {
      if (chosen.includes(b) || b.mass < heaviest.mass * 0.25) continue;
      const near = chosen.some(
        (c) => Math.max(b.top - c.bottom, c.top - b.bottom) <= lineHeight * 1.2
      );
      if (near) {
        chosen.push(b);
        grew = true;
      }
    }
  }

  // Dải hàng chốt theo ngưỡng 10% đỉnh nên vài hàng trên cùng của chữ hoa/dấu mũ
  // (ít pixel) bị loại — đo thật: chữ hoa đầu câu mất nét trên, dấu nặng dưới chân chữ bị cắt.
  // Nới dải ra: dấu mũ/hỏi vươn lên khoảng nửa dòng, dấu nặng và chân chữ g,y,p thòng xuống.
  const lines = chosen
    .map(({ top, bottom }) => ({
      top: Math.max(0, Math.round(top - lineHeight * 0.45)),
      bottom: Math.min(h - 1, Math.round(bottom + lineHeight * 0.4)),
    }))
    .sort((a, b) => a.top - b.top);

  return { lines, lineHeight };
}

/**
 * Chọn các thành phần thuộc dòng phụ đề, bỏ mảnh tranh vẽ.
 *
 * Phụ đề có ba đặc điểm hình học mà mảnh tranh hiếm khi có đủ cả ba:
 *   1. nằm thành DẢI HÀNG dày đặc chữ (một hoặc hai dòng sát nhau)
 *   2. mỗi ký tự có chiều cao xấp xỉ chiều cao dòng, không cao vọt
 *   3. ký tự xếp liền một dải ngang, cách nhau vài pixel — không rải rác
 *
 * @returns {{keep: Set<number>, lines: Array<{top:number,bottom:number}>, lineHeight: number}|null}
 */
export function selectTextComponents(comps, w, h) {
  if (!comps.length) return null;

  // Chiếu chữ lên trục dọc, chỉ tính thành phần đủ lớn để không bị chấm nhiễu kéo lệch.
  const rows = new Uint32Array(h);
  for (const c of comps) {
    if (c.area < 12) continue;
    for (let y = c.y0; y <= c.y1; y++) rows[y] += c.area / (c.y1 - c.y0 + 1);
  }

  const picked = pickLineBands(rows, h);
  if (!picked) return null;
  const { lines, lineHeight } = picked;

  const inLine = (c) => {
    const cy = (c.y0 + c.y1) / 2;
    return lines.some((l) => cy >= l.top && cy <= l.bottom);
  };

  const maxGlyphH = lineHeight * 1.5;
  const candidates = [];
  for (const c of comps) {
    if (c.area < 6) continue;
    if (!inLine(c)) continue;
    if (c.y1 - c.y0 + 1 > maxGlyphH) continue; // vệt tranh cao vọt
    candidates.push(c);
  }

  // Gom cụm theo chiều ngang, riêng từng dòng. Ký tự của một câu nằm liền nhau
  // (khe giữa các từ chỉ cỡ 0,3 chiều cao dòng); mảnh tranh ở rìa khung cách xa
  // hàng trăm pixel. Đo thật: không gom cụm thì khung bao bị kéo từ x=470 ra
  // x=305 và x=1911 chỉ vì vài mảnh tranh hai bên, và OCR sẽ đọc luôn cả chúng.
  const gapMax = lineHeight * 1.2;
  const keep = new Set();
  for (const line of lines) {
    const inThisLine = candidates
      .filter((c) => {
        const cy = (c.y0 + c.y1) / 2;
        return cy >= line.top - 2 && cy <= line.bottom + 2;
      })
      .sort((a, b) => a.x0 - b.x0);
    if (!inThisLine.length) continue;

    const clusters = [];
    let cur = { items: [inThisLine[0]], maxX1: inThisLine[0].x1, area: inThisLine[0].area };
    for (let i = 1; i < inThisLine.length; i++) {
      const c = inThisLine[i];
      if (c.x0 - cur.maxX1 > gapMax) {
        clusters.push(cur);
        cur = { items: [c], maxX1: c.x1, area: c.area };
      } else {
        cur.items.push(c);
        cur.maxX1 = Math.max(cur.maxX1, c.x1);
        cur.area += c.area;
      }
    }
    clusters.push(cur);

    const best = clusters.reduce((a, b) => (b.area > a.area ? b : a));
    for (const c of best.items) keep.add(c.id);
  }
  if (!keep.size) return null;

  return { keep, lines, lineHeight };
}

/**
 * Chữ ký của mặt nạ: lưới ô cố định phủ toàn dải, mỗi ô là mật độ pixel chữ.
 *
 * Lưới cố định theo toạ độ TUYỆT ĐỐI của dải (không theo khung bao) để hai
 * lần quét cùng một phụ đề luôn cho cùng một chữ ký dù khung bao lệch vài pixel.
 */
export function maskSignature(mask, w, h, { cols = 96, rows = 12 } = {}) {
  const sig = new Float32Array(cols * rows);
  const cw = w / cols;
  const ch = h / rows;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(rows - 1, (y / ch) | 0) * cols;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[base + x]) sig[gy + Math.min(cols - 1, (x / cw) | 0)]++;
    }
  }
  return sig;
}

/**
 * Khoảng cách hai chữ ký, chuẩn hoá về [0,1]: 0 = giống hệt, 1 = khác hoàn toàn.
 * Chia cho khối lượng lớn hơn để câu ngắn và câu dài cùng thang đo.
 */
export function signatureDistance(a, b) {
  let diff = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    diff += Math.abs(a[i] - b[i]);
    ma += a[i];
    mb += b[i];
  }
  const m = Math.max(ma, mb);
  return m === 0 ? 0 : diff / (ma + mb);
}

/* ------------------------------------------------------------------ */
/* Đường ống đầy đủ: khung hình → ảnh cho OCR                          */
/* ------------------------------------------------------------------ */

/** Chiều cao dòng mục tiêu (px) mà Tesseract đọc tốt nhất. */
const TARGET_LINE_HEIGHT = 60;

/**
 * Nội suy song tuyến tính (bilinear) — dùng khi phải phóng ảnh nhỏ (phim 480p)
 * lên. Phóng TRƯỚC khi dựng mặt nạ (không phải phóng mặt nạ nhị phân sau) để
 * viền chữ vẫn mượt: nhân đôi mặt nạ nhị phân chỉ cho ra răng cưa.
 */
export function resizeBilinear(img, factor) {
  const { data, width: w, height: h } = img;
  const W = Math.round(w * factor);
  const H = Math.round(h * factor);
  const out = new Uint8ClampedArray(W * H * 4);

  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = data[(y0 * w + x0) * 4 + c] * (1 - tx) + data[(y0 * w + x1) * 4 + c] * tx;
        const b = data[(y1 * w + x0) * 4 + c] * (1 - tx) + data[(y1 * w + x1) * 4 + c] * tx;
        out[o + c] = a * (1 - ty) + b * ty;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

/** Cắt một vùng chữ nhật từ ảnh RGBA. */
export function cropImage(img, x0, y0, x1, y1) {
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const s = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(s, s + cw * 4), y * cw * 4);
  }
  return { data: out, width: cw, height: ch };
}

/**
 * Từ một dải khung hình (RGBA) dựng ảnh sẵn sàng cho OCR.
 *
 * @param {ImageLike} img dải khung hình chứa phụ đề
 * @param {Partial<typeof DEFAULT_MASK_OPTS> & {scale?: number, pad?: number}} opts
 * @returns {null | {
 *   image: ImageLike, mask: Uint8Array, width: number, height: number,
 *   box: {x0:number,x1:number,y0:number,y1:number},
 *   lines: Array<{top:number,bottom:number}>, lineHeight: number, count: number
 * }} null nếu không thấy chữ
 */
export function prepareForOcr(img, opts = {}) {
  const run = (src, o) => {
    const m = textMask(src, o);
    const { labels, comps } = components(m.mask, m.width, m.height);
    const sel = selectTextComponents(comps, m.width, m.height);
    if (!sel) return null;

    // Chỉ giữ pixel thuộc thành phần được chọn.
    const keepFlag = new Uint8Array(comps.length ? Math.max(...comps.map((c) => c.id)) + 1 : 1);
    for (const id of sel.keep) keepFlag[id] = 1;
    const clean = new Uint8Array(m.mask.length);
    for (let i = 0; i < clean.length; i++) if (m.mask[i] && keepFlag[labels[i]]) clean[i] = 1;

    const top = sel.lines[0].top;
    const bottom = sel.lines[sel.lines.length - 1].bottom;
    const box = bboxInRows(clean, m.width, Math.max(0, top - 4), Math.min(m.height - 1, bottom + 4));
    if (!box) return null;
    return { ...m, mask: clean, box, lines: sel.lines, lineHeight: sel.lineHeight };
  };

  let out = run(img, opts);
  if (!out) return null;

  // Chữ nhỏ (phim độ phân giải thấp) → phóng lên rồi dựng lại mặt nạ.
  // Cần lineHeight của MỘT dòng: nếu có nhiều dòng thì lấy chiều cao trung bình.
  const perLine = out.lineHeight;
  if (perLine < TARGET_LINE_HEIGHT * 0.7) {
    const factor = Math.min(3, TARGET_LINE_HEIGHT / perLine);
    const padPx = 6;
    const crop = cropImage(
      img,
      Math.max(0, out.box.x0 - padPx),
      Math.max(0, out.box.y0 - padPx),
      Math.min(img.width - 1, out.box.x1 + padPx),
      Math.min(img.height - 1, out.box.y1 + padPx)
    );
    const big = resizeBilinear(crop, factor);
    const again = run(big, { ...opts, scale: (opts.scale ?? 1) * factor });
    if (again) out = again;
  }

  const image = maskToImage(out.mask, out.width, out.height, out.box, { pad: opts.pad ?? 14 });
  return { ...out, image };
}

/* ------------------------------------------------------------------ */
/* Tầng quét nhẹ — chạy mỗi ~250ms trong trang phim                    */
/* ------------------------------------------------------------------ */

/**
 * Tầng nhẹ chỉ cần trả lời hai câu hỏi rẻ: "có chữ không?" và "có phải câu
 * mới không?". Không dựng mặt nạ đầy đủ (đắt), chỉ đếm pixel TRẮNG TINH có
 * viền tối sát bên — đúng dấu hiệu của nét chữ hardsub.
 *
 * Chạy ở nửa độ phân giải: nét chữ ~10px ở 1080p còn ~5px, vẫn giữ được lõi
 * trắng tinh. Xuống thấp hơn nữa thì viền đen làm nhoè lõi trắng, mất tín hiệu.
 */
export const QUICK_OPTS = {
  /** Lõi chữ phải sáng ít nhất chừng này (thấp hơn 240 chút vì bị nội suy khi thu nhỏ). */
  whiteMin: 235,
  /** Viền phải tối nhất chừng này. */
  darkMax: 90,
  /** Tìm viền tối trong bán kính này (px ở độ phân giải quét). */
  reach: 2,
  /**
   * Tỉ lệ pixel "trắng có viền" tối thiểu trên cả dải để coi là có chữ. Hiệu chuẩn từ
   * số đo thật: khung không phụ đề ≤ 0,08%; câu phụ đề ngắn nhất đo được ≥ 0,8%.
   * 0,35% nằm giữa, cách xa cả hai phía.
   */
  minRatio: 0.0035,
  /**
   * Lưới chữ ký phủ dải: số cột × số hàng. Đo thật trên chuỗi 92 khung: lưới thô 64×12
   * chỉ tách được câu-khác-câu (gần nhất 0,143) gấp 4,5 lần độ trôi trong một câu (0,032);
   * lưới 192×32 tách gấp 30 lần (0,493 so với 0,016). Lưới thô suýt coi hai câu khác nhau
   * nhưng cùng độ dài là một — lỗi im lặng, hiện nhầm bản dịch của câu cũ.
   */
  gridCols: 192,
  gridRows: 32,
  /** Ô "có chữ" khi pixel trắng-có-viền chiếm ít nhất tỉ lệ này diện tích ô. */
  cellMin: 0.12,
};

/**
 * @param {ImageLike} img dải khung hình (thường đã thu nhỏ còn nửa)
 * @param {Partial<typeof QUICK_OPTS> & {scale?: number}} opts scale = độ phân giải quét / gốc
 * @returns {{
 *   present: boolean, count: number, ratio: number,
 *   lines: Array<{top:number,bottom:number}>|null, lineHeight: number,
 *   x0: number, x1: number, occ: Uint8Array
 * }}
 */
export function quickScan(img, opts = {}) {
  const o = { ...QUICK_OPTS, ...opts };
  const { data, width: w, height: h } = img;
  const s = o.scale ?? 1;
  // Bộ quét luôn chuẩn hoá bề rộng về ~960px nên bề dày nét chữ trong ảnh quét gần như
  // hằng số (không co giãn theo độ phân giải video) → dùng thẳng o.reach, người gọi tự
  // giảm khi video nhỏ hơn 960px.
  const reach = Math.max(1, Math.round(o.reach));

  const luma = lumaPlane(img);
  const rows = new Uint32Array(h);
  const grid = new Uint16Array(o.gridCols * o.gridRows);
  const cw = w / o.gridCols;
  const ch = h / o.gridRows;
  let count = 0;

  for (let y = reach; y < h - reach; y++) {
    const gy = Math.min(o.gridRows - 1, (y / ch) | 0) * o.gridCols;
    const base = y * w;
    for (let x = reach; x < w - reach; x++) {
      const i = base + x;
      if (luma[i] < o.whiteMin) continue; // đa số pixel dừng ở đây → rất rẻ
      if (
        luma[i - reach] <= o.darkMax ||
        luma[i + reach] <= o.darkMax ||
        luma[i - reach * w] <= o.darkMax ||
        luma[i + reach * w] <= o.darkMax
      ) {
        count++;
        rows[y]++;
        grid[gy + Math.min(o.gridCols - 1, (x / cw) | 0)]++;
      }
    }
  }

  const ratio = count / (w * h);
  const empty = {
    present: false, count, ratio, lines: null, lineHeight: 0, x0: 0, x1: 0,
    occ: new Uint8Array(o.gridCols * o.gridRows),
  };
  if (ratio < o.minRatio) return empty;

  const picked = pickLineBands(rows, h, { scale: s });
  if (!picked) return empty;
  const { lines, lineHeight } = picked;

  // Cột chứa chữ: chỉ tính trong các dải hàng đã chọn, rồi gom cụm ngang — mảnh
  // tranh ở rìa khung không được kéo giãn vùng cắt.
  const cols = new Uint32Array(w);
  for (const l of lines) {
    for (let y = Math.max(reach, l.top); y <= Math.min(h - reach - 1, l.bottom); y++) {
      const base = y * w;
      for (let x = reach; x < w - reach; x++) {
        const i = base + x;
        if (luma[i] < o.whiteMin) continue;
        if (
          luma[i - reach] <= o.darkMax || luma[i + reach] <= o.darkMax ||
          luma[i - reach * w] <= o.darkMax || luma[i + reach * w] <= o.darkMax
        ) cols[x]++;
      }
    }
  }

  const gapMax = lineHeight * 1.2;
  let best = null;
  let cur = null;
  for (let x = 0; x <= w; x++) {
    const on = x < w && cols[x] > 0;
    if (on) {
      if (cur && x - cur.x1 > gapMax) {
        if (!best || cur.mass > best.mass) best = cur;
        cur = null;
      }
      if (!cur) cur = { x0: x, x1: x, mass: 0 };
      cur.x1 = x;
      cur.mass += cols[x];
    }
  }
  if (cur && (!best || cur.mass > best.mass)) best = cur;
  if (!best) return empty;

  // Câu phụ đề thật là một dải NGANG rộng; cụm hẹp là nhiễu tranh vẽ.
  if (best.x1 - best.x0 + 1 < lineHeight * 1.5) return empty;

  // Chữ ký: chỉ những ô nằm trong vùng chữ đã chọn.
  const occ = new Uint8Array(o.gridCols * o.gridRows);
  const cellArea = cw * ch;
  for (let gy = 0; gy < o.gridRows; gy++) {
    const cy0 = gy * ch;
    const cy1 = cy0 + ch;
    if (!lines.some((l) => l.bottom >= cy0 && l.top <= cy1)) continue;
    for (let gx = 0; gx < o.gridCols; gx++) {
      const cx0 = gx * cw;
      if (cx0 + cw < best.x0 || cx0 > best.x1) continue;
      if (grid[gy * o.gridCols + gx] >= o.cellMin * cellArea) occ[gy * o.gridCols + gx] = 1;
    }
  }

  return { present: true, count, ratio, lines, lineHeight, x0: best.x0, x1: best.x1, occ };
}

/**
 * Khoảng cách Jaccard giữa hai chữ ký ô: 0 = cùng một câu, 1 = khác hoàn toàn.
 * Dùng tập ô có/không thay vì mật độ: nhiễu nén video làm mật độ dao động nhưng
 * ô nào có chữ vẫn có chữ, nên Jaccard ổn định hơn nhiều so với L1 trên mật độ.
 */
export function occDistance(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ? 1 : 0;
    const y = b[i] ? 1 : 0;
    inter += x & y;
    union += x | y;
  }
  return union === 0 ? 0 : 1 - inter / union;
}
