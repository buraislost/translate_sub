# Sprint 3 — OCR (đọc phụ đề cháy trên hình)

**Mục tiêu**: đọc hardsub (chữ đã in vào pixel) thành cue text, chạy trong browser.

**Định nghĩa "xong"**: mở một phim hardsub tiếng Việt → bật Translate Sub → phụ đề được đọc ra và hiển thị lại được ở dạng text, CER dưới 0,20 trên test set.

**Lưu ý**: không có repo nào làm sẵn việc này trong browser. Các project hiện có (`videocr`, `VideOCR`) đều là Python chạy offline trên file video. Đây là phần đóng góp gốc của project — cũng là phần viết được vào báo cáo.

---

## Giới hạn cứng: canvas tainted

`ctx.drawImage(video, ...)` rồi `getImageData()` sẽ ném `SecurityError` nếu canvas bị "nhiễm bẩn".

| Trường hợp | Tainted? | OCR chạy được? |
|---|---|---|
| Video qua HLS.js / MSE (`blob:` URL) | Không | ✅ — đa số web phim Việt nằm ở đây |
| `<video src>` cross-origin không có CORS header | Có | ❌ |
| `crossorigin="anonymous"` + server trả CORS | Không | ✅ |
| **DRM / EME** (Netflix, Prime, Disney+) | Có, vĩnh viễn | ❌ **không có cách nào** |

Với DRM thì OCR chết nhưng ASR vẫn sống — đó là lý do Sprint 2 làm trước.

**Việc đầu tiên của sprint này là T3.1: đo xem thực tế site nào đọc được pixel.** Nếu kết quả cho thấy đa số site mục tiêu đều tainted thì phải đổi hướng sang `tabCapture`, và cần biết điều đó trước khi bỏ hai tuần viết pipeline.

---

## Nhiệm vụ

### T3.1 — Khảo sát tainted (làm trước tiên)

**File mới**: `src/dev/taint-probe.js` (chỉ dùng lúc dev)

- Hàm thử `drawImage` + `getImageData` trên video hiện tại, trả `{ ok, error }`
- Thêm nút ẩn trong popup để chạy thử
- Chạy trên tối thiểu 5 site: 2 web phim Việt, YouTube, Vimeo, 1 file local
- Ghi kết quả vào `docs/taint-report.md`

**Xong khi**: có bảng site nào đọc được pixel.

### T3.2 — Đóng gói Tesseract.js

**Thư mục mới**: `vendor/tesseract/`

CSP của MV3 chặn tải script và WASM từ CDN → phải đặt sẵn trong extension:

- `tesseract.min.js`
- `worker.min.js`
- `tesseract-core.wasm.js`
- `vie.traineddata`, `eng.traineddata`

Manifest cần `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }` — đã có sẵn từ Sprint 1.

Cấu hình khởi tạo:

```js
const worker = await Tesseract.createWorker('vie+eng', 1, {
  workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
  corePath:   chrome.runtime.getURL('vendor/tesseract/'),
  langPath:   chrome.runtime.getURL('vendor/tesseract/'),
});
await worker.setParameters({
  tessedit_pageseg_mode: '6',        // SINGLE_BLOCK — khối text nhiều dòng
  preserve_interword_spaces: '1',
});
```

**Xong khi**: OCR được một ảnh PNG tĩnh có chữ tiếng Việt.

### T3.3 — Capture frame và chọn vùng

**File mới**: `src/core/frame.js`

- Crop mặc định: 25% phía dưới, 80% chiều ngang ở giữa
- Cho người dùng kéo chỉnh vùng crop (nhiều phim đặt sub ở vị trí lạ)
- **Nâng cao — tự dò vùng sub**: lấy 50 frame rải rác, tính phương sai (variance) theo từng hàng pixel; hàng nào có phương sai cao đột biến so với nền là dải chứa chữ. Đây là bài toán thống kê nhỏ, nên làm vì viết được vào báo cáo

**Xong khi**: xuất được ảnh crop đúng vùng phụ đề.

### T3.4 — Tiền xử lý (quyết định 80% độ chính xác)

**File mới**: `src/core/preprocess.js`

Tesseract chỉ là máy đọc; chất lượng ảnh đầu vào mới là phần kỹ thuật thật.

| Bước | Mục đích | Cách làm |
|---|---|---|
| Upscale 2–3× | Tesseract cần chữ cao ~30px | `imageSmoothingQuality = 'high'` rồi vẽ phóng to |
| Grayscale | 3 kênh → 1 | `0.299R + 0.587G + 0.114B` |
| Binarize | Tách chữ khỏi nền | **Otsu** — tự tìm ngưỡng, không dùng ngưỡng cố định |
| Invert nếu cần | Tesseract thích chữ đen nền trắng | Đếm pixel trắng, > 50% thì đảo |
| Morphological close | Nối nét chữ đứt do nén video | Dilate rồi erode 1 lần |

**Về Otsu**: duyệt 256 mức xám, chọn ngưỡng **tối đa hoá phương sai giữa hai lớp** (between-class variance). Bản chất là bài toán phân cụm 1 chiều. Viết thành hàm riêng `otsuThreshold(histogram)` và **có test** — đây là hàm thuần tuý, test được bằng `node:test`.

**Xong khi**: `tests/preprocess.test.mjs` pass, và ảnh sau xử lý nhìn rõ chữ đen trên nền trắng.

### T3.5 — Lọc frame trùng

**File mới**: `src/core/dhash.js`

Không có bước này, OCR sẽ đọc lại cùng một câu 10–15 lần và máy treo.

```js
// dHash 64-bit: thu nhỏ về 9×8, so sánh pixel liền kề theo hàng
function dHash(imageData) { /* ... */ }
// Hamming distance < 5 → cùng một khung sub → bỏ qua
```

Hai bộ lọc chạy **trước** khi gọi Tesseract:

1. **Empty detection** — sau binarize, tỉ lệ pixel đen < 0,5% → không có chữ → bỏ qua ngay
2. **Change detection** — dHash giống frame trước → bỏ qua

Hai bộ lọc này cắt khoảng 90% lời gọi OCR. Nhịp quét: mỗi ~400ms.

**Xong khi**: `tests/dhash.test.mjs` pass; log cho thấy số lần gọi OCR thấp hơn nhiều so với số frame quét.

### T3.6 — Hậu xử lý thành cue

**File mới**: `src/core/postprocess.js`

- **Lọc confidence**: bỏ từ có `confidence < 65` (giá trị khởi điểm lấy từ `videocr`)
- **Temporal smoothing**: text phải xuất hiện ổn định ≥ 2 lần đọc liên tiếp mới chốt `start`; biến mất ≥ 2 lần mới đóng `end`
- **Fuzzy merge**: hai lần đọc ra `"Xin chào anh"` và `"Xin chao anh"` → tỉ lệ Levenshtein ≥ 90% thì gộp, giữ bản confidence cao hơn (ngưỡng 90 cũng lấy từ `videocr`)
- **Sửa dấu tiếng Việt**: Tesseract đọc dấu thanh khá tệ, hay nhầm `ả/à/ã`, `ê/ệ`. So khớp với từ điển tiếng Việt, sửa khi khoảng cách Levenshtein ≤ 1

Viết hàm `levenshtein(a, b)` riêng và có test — Sprint 5 sẽ dùng lại chính hàm này để tính CER/WER.

**Xong khi**: `tests/postprocess.test.mjs` pass.

### T3.7 — `OcrSource`

**File mới**: `src/sources/OcrSource.js`

- Kế thừa `SubtitleSource`
- `start()` mở vòng quét 400ms trong offscreen document (tái dùng hạ tầng Sprint 2)
- Tesseract chạy trong Web Worker, không bao giờ ở main thread
- Cache cue vào IndexedDB theo hash video

**Xong khi**: phim hardsub hiện được phụ đề text do chính extension đọc ra.

---

## Phương án dự phòng nếu Tesseract đọc dấu quá tệ

Đổi sang **PaddleOCR** chạy qua ONNX Runtime Web. Chất lượng tiếng Việt tốt hơn hẳn, nhưng phải tự export model và tự viết phần decode — khó hơn đáng kể. Chỉ chuyển khi T3.6 cho CER > 0,30 dù đã tinh chỉnh tiền xử lý.

Ghi lại quyết định và số liệu vào `docs/taint-report.md` để Sprint 5 dùng.

## Repo tham khảo

| Repo | Xem phần nào |
|---|---|
| `apm1467/videocr` | `conf_threshold=65`, `sim_threshold=90`, crop nửa dưới |
| `timminator/VideOCR` | PaddleOCR + SSIM phát hiện đổi frame |
| `shawnsky/extract-subtitles` | Trích key frame, crop vùng sub |
| `jeromewu/tesseract.js-chrome-extension` | Đóng gói WASM + traineddata vào extension |
