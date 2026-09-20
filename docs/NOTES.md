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

**Thứ tự đã đảo so với kế hoạch gốc.** Mục tiêu thật: đọc hardsub **tiếng Việt** trên web phim rồi hiện dòng **tiếng Anh** dịch máy. ASR không đọc được bản dịch đã cháy sẵn trong clip nên bị đẩy xuống sau.

| Phase | Nội dung | Trạng thái |
|---|---|---|
| — | Xương sống + `SrtFileSource` + overlay + offset | ✅ xong |
| 0 | Thăm dò: canvas tainted + Translator API | ✅ xong — `docs/probe-report.md` |
| 1 | Offscreen + đóng gói Tesseract.js | 🔄 đang làm |
| 2 | Bắt frame, dHash, lọc frame trùng | ⬜ |
| 3 | Tiền xử lý (white-mask/Otsu) + lắp cue + sửa dấu theo âm tiết | ⬜ |
| 4 | `TranslatedSource` + giao diện | ⬜ |
| 5 | Đo CER/WER, ablation study | ⬜ `docs/sprint-5-benchmark.md` |
| sau | ASR — offscreen, AudioWorklet, Whisper, VAD | ⬜ `docs/sprint-2-asr.md` |

`docs/sprint-3-ocr.md` vẫn là tài liệu tham chiếu cho Phase 1–3, nhưng **thứ tự nhiệm vụ trong đó đã lỗi thời** — bám theo bảng trên.

## Quyết định đã chốt (đừng mở lại nếu không có số liệu mới)

| Quyết định | Lý do |
|---|---|
| OCR trước, ASR sau | Sub đã cháy sẵn trong clip là **bản dịch người làm** — ASR không đọc được nó |
| Tesseract.js, không phải PaddleOCR | Hardsub dùng font họ Arial, đúng nhóm Tesseract mạnh (>97%). Giữ engine thay được để Phase 5 so sánh |
| Chrome Translator API, không phải transformers.js | Đã đo: dùng được ở offscreen → **0 byte** vendor thay vì ~75MB |
| Phần dịch đặt ở **offscreen document** | Translator API không chạy trong Web Worker; offscreen đã đo là chạy được |
| Overlay **chỉ hiện dòng tiếng Anh** | Tiếng Việt đã cháy sẵn trên hình, vẽ đè lên sẽ chồng chữ. Dữ liệu vẫn giữ cả hai để xuất `.srt` |
| Ngôn ngữ nguồn là **tham số**, mặc định `vi` | Để sau này gặp hardsub Trung/Hàn không phải sửa lõi |

Khi bắt đầu một phase, **đọc `docs/probe-report.md` và bảng cạm bẫy bên dưới trước khi viết code.**

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
| `import()` **động** trong `sw.js` | `TypeError: import() is disallowed on ServiceWorkerGlobalScope` | Dùng static import — chạy được vì manifest có `"type": "module"` |
| Giả định video là 16:9 | Vùng crop lệch khỏi dải phụ đề | Tính từ `videoWidth`/`videoHeight` thật. Đã gặp phim **1924×1040** (~1,85:1) |
| Gọi `Translator.create()` từ offscreen khi model chưa tải | Treo hoặc ném lỗi — Chrome đòi user gesture | Tải lần đầu từ **popup** (cú click là gesture). Xong rồi mọi context đều dùng được |
| `Translator` xử lý tuần tự | Gọi song song chỉ xếp hàng ngầm | Một hàng đợi, và **không bao giờ để dòng gốc chờ bản dịch** |
