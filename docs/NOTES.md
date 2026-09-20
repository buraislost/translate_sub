# SubForge

Chrome extension (Manifest V3) hiển thị **hai phụ đề song song** trên mọi website có `<video>`.
Điểm khác biệt so với các extension cùng loại: tự **sinh** phụ đề bằng OCR (chữ cháy trên hình) và ASR (nhận dạng tiếng nói), không chỉ hiển thị sub có sẵn.

## Lệnh

```bash
node --test "tests/**/*.test.mjs"   # chạy test
node --check <file.js>              # kiểm tra cú pháp một file
```

Không có `npm install`, không có bước build, không có bundler. Đây là quyết định có chủ đích — xem phần Ràng buộc.

Nạp extension: `chrome://extensions` → Developer mode → Load unpacked → chọn thư mục gốc repo.

## Ràng buộc bắt buộc tuân thủ

1. **Không thêm bước build.** Không webpack, rollup, vite, TypeScript, JSX. Code phải chạy thẳng trong Chrome sau khi Load unpacked. Mỗi lớp build là một lớp che khuất thứ cần hiểu.
2. **Không thêm dependency từ npm registry lúc runtime.** Thư viện lớn (Tesseract.js, transformers.js) phải được **tải về và đặt trong `vendor/`**, vì CSP của MV3 chặn tải script từ CDN.
3. **ES module, dynamic import.** Content script MV3 không hỗ trợ `import` tĩnh — `src/content.js` là classic script duy nhất, nó `import()` động `src/main.js`. Mọi file khác dùng module chuẩn và phải nằm trong `web_accessible_resources` của manifest.
4. **Comment bằng tiếng Việt, code (tên biến/hàm) bằng tiếng Anh.** Comment giải thích **vì sao** chọn cách làm đó, không mô tả lại code đang làm gì.

## Kiến trúc — hai trục mở rộng

Đây là thứ quan trọng nhất cần hiểu trước khi sửa bất cứ gì.

### Trục 1: nguồn phụ đề — `src/core/SubtitleSource.js`

Mọi nguồn phụ đề implement cùng một contract:

```js
class SubtitleSource {
  async init(videoEl) {}
  async start() {}
  async stop() {}
  onCue(fn) {}      // nguồn realtime bắn từng cue
  cueAt(time) {}    // binary search, O(log n) — đã có sẵn ở lớp cha
}
```

Cue chuẩn dùng chung toàn project: `{ start, end, text, confidence? }`, đơn vị **giây** (số thực).

Hệ quả: thêm OCR hay ASR = **thêm một class trong `src/sources/`**, tuyệt đối không sửa `renderer.js` hay `sync.js`. Nếu thấy mình đang phải sửa hai file đó để thêm nguồn mới, nghĩa là contract đang bị vi phạm — dừng lại và xem lại thiết kế.

### Trục 2: nền tảng — `src/adapters/base.js`

```js
class BaseAdapter {
  static match(url) {}
  getVideo() {}
  getContainer() {}    // nơi gắn overlay — QUAN TRỌNG cho fullscreen
  hideNativeSubs() {}
}
```

Thêm website mới = thêm file ~30 dòng trong `src/adapters/`, đăng ký vào `registry.js` **phía trên** `UniversalAdapter` (adapter này luôn `match()` true nên phải đứng cuối).

## Cấu trúc thư mục

```
manifest.json
src/
  content.js          loader (classic script duy nhất)
  main.js             điều phối: tìm video → gắn overlay → nhận message
  sw.js               service worker
  core/               SubtitleSource, parser, renderer, sync, store
  sources/            SrtFileSource (+ WhisperSource, OcrSource sắp tới)
  adapters/           base, universal, youtube, registry
  popup/              giao diện
tests/                test bằng node:test, không framework
docs/                 kế hoạch từng sprint
vendor/               thư viện tải sẵn (chưa có)
```

## Trạng thái

| Sprint | Nội dung | Trạng thái |
|---|---|---|
| 1 | Xương sống + `SrtFileSource` + overlay + offset | ✅ xong |
| 2 | ASR — offscreen, AudioWorklet, Whisper, VAD | ⬜ kế hoạch: `docs/sprint-2-asr.md` |
| 3 | OCR — canvas, Otsu, dHash, Tesseract | ⬜ kế hoạch: `docs/sprint-3-ocr.md` |
| 4 | Dịch máy + cache IndexedDB | ⬜ |
| 5 | Đo CER/WER, ablation study | ⬜ kế hoạch: `docs/sprint-5-benchmark.md` |

Khi bắt đầu một sprint, **đọc file kế hoạch tương ứng trong `docs/` trước khi viết code.**

## Những cạm bẫy đã biết — đừng lặp lại

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Quên `source.connect(ctx.destination)` khi lấy audio | Người dùng **mất hẳn tiếng** | Luôn nối lại về destination |
| Canvas bị tainted | `getImageData` ném `SecurityError` | Bọc try/catch, fallback sang `tabCapture`; DRM thì chịu, không có cách nào |
| Service worker MV3 bị kill sau ~30s idle | Phiên OCR/ASR đứt giữa chừng | Heartbeat trong lúc tác vụ chạy |
| Gắn overlay vào `document.body` | Mất phụ đề khi fullscreen | Gắn vào `adapter.getContainer()` |
| Chạy WASM ở main thread | Video giật | Mọi inference phải trong Web Worker |
| OCR mỗi frame | Treo máy, đọc lại cùng câu chục lần | dHash/SSIM lọc frame trùng trước khi gọi OCR |
| Dịch từng dòng sub một | Mất ngữ cảnh, dính rate limit | Gom batch 20–30 câu |
