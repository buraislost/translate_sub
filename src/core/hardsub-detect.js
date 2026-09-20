/**
 * hardsub-detect.js — trả lời câu hỏi "video này có phụ đề cháy không?"
 *
 * Vì sao cần file này: đo thực tế trên web phim A cho thấy có những phim
 * KHÔNG hề có hardsub (server "Song Ngữ" hoá ra là chọn tiếng lồng, không
 * phải phụ đề). Khi đó Tesseract vẫn chạy, vẫn trả về chuỗi — nhưng là rác
 * đọc từ nhiễu ảnh: "Lư, v.)N va »" ở confidence 44%.
 *
 * Không có bước kiểm tra này, extension sẽ ngốn CPU cả tiếng đồng hồ để sinh
 * ra phụ đề vô nghĩa, và người dùng không hiểu vì sao. Thà nói thẳng
 * "phim này không có sub cháy" ngay từ đầu.
 *
 * Dấu hiệu nhận biết: chữ hardsub gần như luôn là LÕI SÁNG + VIỀN TỐI. Cảnh
 * phim sáng (bầu trời, tường trắng) có lõi sáng nhưng KHÔNG có viền tối bao
 * quanh — đó chính là chỗ để phân biệt, và là lý do phép đo này ăn đứt việc
 * chỉ đếm pixel trắng.
 */

/** Pixel được coi là "lõi chữ" khi cả ba kênh đều sáng hơn ngưỡng này. */
const CORE_MIN = 195;

/** Pixel được coi là "viền" khi cả ba kênh đều tối hơn ngưỡng này. */
const EDGE_MAX = 90;

/** Khoảng cách từ lõi ra viền, tính bằng pixel ở độ phân giải gốc. */
const EDGE_DISTANCE = 3;

/**
 * Ngưỡng phân định, tính bằng TỈ LỆ pixel có viền trên tổng số pixel đã lấy mẫu.
 *
 * Hiệu chuẩn từ số đo thật trên web phim A (phim không có hardsub):
 * cao nhất 77 pixel trên ~140.000 mẫu = 0,055%. Một dòng phụ đề thật cho ra
 * cỡ vài nghìn pixel = 2–4%. Đặt ngưỡng 0,5% nằm giữa hai vùng, cách xa cả hai.
 *
 * Cần hiệu chuẩn lại nếu đổi CORE_MIN/EDGE_MAX.
 */
export const HARDSUB_RATIO_THRESHOLD = 0.005;

/**
 * Đếm pixel "lõi sáng có viền tối" trong một vùng ảnh.
 *
 * Lấy mẫu thưa (bước 2px) thay vì duyệt từng pixel: chữ phụ đề dày hàng chục
 * pixel nên bỏ một nửa không làm sai kết luận, mà nhanh gấp bốn. Hàm này chạy
 * mỗi 400ms nên tốc độ là ràng buộc thật.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @returns {{count: number, sampled: number, ratio: number, rows: number[]}}
 */
export function outlinedTextScore(img, { step = 2, coreMin = CORE_MIN, edgeMax = EDGE_MAX, edgeDistance = EDGE_DISTANCE } = {}) {
  const { data, width: w, height: h } = img;
  const rows = new Array(h).fill(0);

  const isCore = (x, y) => {
    const i = (y * w + x) * 4;
    return data[i] > coreMin && data[i + 1] > coreMin && data[i + 2] > coreMin;
  };
  const isEdge = (x, y) => {
    const i = (y * w + x) * 4;
    return data[i] < edgeMax && data[i + 1] < edgeMax && data[i + 2] < edgeMax;
  };

  let count = 0;
  let sampled = 0;
  const d = edgeDistance;

  for (let y = d; y < h - d; y += step) {
    for (let x = d; x < w - d; x += step) {
      sampled++;
      if (!isCore(x, y)) continue;
      // Đủ MỘT hướng có viền tối là tính — chữ nằm ở mép khung hình vẫn đếm được.
      if (isEdge(x - d, y) || isEdge(x + d, y) || isEdge(x, y - d) || isEdge(x, y + d)) {
        count++;
        rows[y]++;
      }
    }
  }

  return { count, sampled, ratio: sampled ? count / sampled : 0, rows };
}

/**
 * Tìm dải chứa phụ đề trong vùng đã quét.
 *
 * Trả về vị trí theo TỈ LỆ (0–1) so với chiều cao vùng quét, không phải pixel —
 * để bên gọi quy đổi sang khung hình thật mà không cần biết ta quét ở đâu.
 * Đo thực tế cho thấy không được giả định 16:9 (đã gặp phim 1924×1040).
 */
export function detectSubtitleBand(img, opts = {}) {
  const { rows, ratio, count } = outlinedTextScore(img, opts);
  if (count === 0) return null;

  const peak = Math.max(...rows);
  // Ngưỡng theo tỉ lệ của đỉnh: chữ đậm hơn hẳn nhiễu rải rác xung quanh.
  const cut = peak * 0.15;

  let top = -1;
  let bottom = -1;
  for (let y = 0; y < rows.length; y++) {
    if (rows[y] > cut) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return null;

  return {
    top: top / img.height,
    bottom: (bottom + 1) / img.height,
    ratio,
    count,
  };
}

/**
 * Gộp kết quả quét nhiều frame thành một kết luận.
 *
 * Vì sao phải nhiều frame: phim nào cũng có đoạn không thoại. Một frame trống
 * không chứng minh được điều gì — chỉ khi quét rải khắp phim mà KHÔNG frame nào
 * có chữ thì mới kết luận được là phim không có hardsub.
 *
 * @param {number[]} ratios tỉ lệ đo được ở từng frame
 */
export function summarizeScan(ratios, { threshold = HARDSUB_RATIO_THRESHOLD } = {}) {
  const n = ratios.length;
  if (n === 0) return { hasHardsub: null, reason: 'chưa quét frame nào', hitRate: 0, maxRatio: 0 };

  const hits = ratios.filter((r) => r >= threshold).length;
  const maxRatio = Math.max(...ratios);
  const hitRate = hits / n;

  // Chỉ cần MỘT frame có chữ là đủ kết luận có hardsub — phần còn lại là
  // đoạn không thoại, hoàn toàn bình thường.
  if (hits > 0) {
    return {
      hasHardsub: true,
      reason: `${hits}/${n} frame có chữ viền`,
      hitRate,
      maxRatio,
    };
  }

  // Quét ít quá thì không dám kết luận — nói "chưa chắc" thay vì nói sai.
  if (n < 8) {
    return {
      hasHardsub: null,
      reason: `mới quét ${n} frame, chưa đủ để kết luận`,
      hitRate: 0,
      maxRatio,
    };
  }

  return {
    hasHardsub: false,
    reason: `${n} frame rải khắp phim đều không thấy chữ viền`,
    hitRate: 0,
    maxRatio,
  };
}
