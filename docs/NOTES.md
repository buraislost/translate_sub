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

### Trục 3: đường ống OCR — content script (nhẹ) → offscreen (nặng)

```
Content script                          Offscreen document
───────────────                         ──────────────────
scanner.js: quét dải đáy khung hình      ocr-service.js: mặt nạ đầy đủ
  mỗi ~280ms, nửa độ phân giải,            (preprocess.js: top-hat, hạt
  ~1,3ms/lần (quickScan)                   giống trắng, gom cụm) + Tesseract
        │                                         │
cue-tracker.js: chữ ký đổi → câu mới?    translate-service.js: hàng đợi
        │                                  dịch tuần tự, cache theo text
OcrSource (sources/): phát cue tiếng Việt         │
        │                                         │
TranslatedSource (sources/): bọc OcrSource, gọi offscreen-client.js
  qua chrome.runtime.sendMessage(..., {target:'offscreen'})
```

Vì sao chia hai tầng: quét MỌI frame để tìm "có chữ không" phải rẻ (chạy
trong content script, cùng luồng với trang phim); dựng mặt nạ đầy đủ +
Tesseract thì đắt (50–150ms) nên chỉ chạy khi tầng nhẹ báo có **câu mới**,
và luôn ở offscreen — không bao giờ ở content script.

## Cấu trúc thư mục

```
manifest.json
src/
  content.js          loader (classic script duy nhất)
  main.js             điều phối: tìm video → gắn overlay → nhận message,
                       bật/tắt OCR, khôi phục cue từ cache
  sw.js               service worker: dựng offscreen, chuyển tiếp probe, heartbeat
  core/
    SubtitleSource.js  contract chung
    parser.js, renderer.js, sync.js, store.js   (Sprint 1)
    preprocess.js      mặt nạ chữ, top-hat, thành phần liên thông, quickScan
    cue-tracker.js     chuỗi kết quả quét → cue có start/end
    scanner.js         BandScanner — lấy dải khung hình từ <video>
    text-utils.js      dọn chuỗi OCR, tách/gộp phát ngôn để dịch
    text-metrics.js    levenshtein/CER/WER, chuẩn hoá NFC
    offscreen-client.js  content script gọi offscreen (tự ensure + retry)
    idb-cache.js       cache cue vào IndexedDB của trang, theo href+duration
    errors.js          describeError() — mô tả lỗi dù là Error/chuỗi/khác
  offscreen/
    offscreen.html/js   điều phối message, một TesseractEngine dùng chung
    ocr-engine.js        lớp bọc Tesseract.js
    ocr-service.js        prepareForOcr() + Tesseract → text đã dọn
    translate-service.js  Chrome Translator API, hàng đợi + cache
  sources/
    SrtFileSource.js, OcrSource.js, TranslatedSource.js
  adapters/            base, universal, youtube, registry
  popup/               giao diện — toggle OCR, thăm dò kỹ thuật
  dev/                 probe.js, ocr-selftest.js — chỉ dùng lúc phát triển
tests/                 test bằng node:test, không framework — 65 test
docs/                  kế hoạch từng sprint + probe-report.md
benchmark/             ground-truth gán nhãn tay — chỉ giữ cục bộ, không commit
vendor/                Tesseract.js 7.0.0 + core + vie.traineddata (~8,2MB)
```

## Trạng thái

**Thứ tự đã đảo so với kế hoạch gốc.** Mục tiêu thật: đọc hardsub **tiếng Việt** trên web phim rồi hiện dòng **tiếng Anh** dịch máy. ASR không đọc được bản dịch đã cháy sẵn trong clip nên bị đẩy xuống sau.

| Phase | Nội dung | Trạng thái |
|---|---|---|
| — | Xương sống + `SrtFileSource` + overlay + offset | ✅ xong |
| 0 | Thăm dò: canvas tainted + Translator API | ✅ xong — `docs/probe-report.md` |
| 1 | Offscreen + đóng gói Tesseract.js | ✅ xong |
| 2 | `quickScan` (tầng nhẹ), `CueTracker` | ✅ xong — đo trên chuỗi 92 khung thật |
| 3 | `prepareForOcr` (top-hat + hạt giống trắng), `OcrSource` | ✅ xong — CER 0,031 trên 22 khung thật |
| 4 | `TranslatedSource`, cache IndexedDB, giao diện popup | ✅ xong — kiểm chứng **end-to-end trên site thật** |
| 5 | Đo CER/WER, ablation study có hệ thống (bảng so từng bước) | ⬜ — đã có hạ tầng đo (`text-metrics.js`), chưa viết `benchmark/score.mjs` |
| sau | ASR — offscreen, AudioWorklet, Whisper, VAD | ⬜ `docs/sprint-2-asr.md` |

`docs/sprint-3-ocr.md` là tài liệu **lịch sử** (kế hoạch ban đầu) — thứ tự nhiệm vụ trong đó đã lỗi thời, bám theo bảng trên và phần "Quyết định đã chốt" bên dưới.

### Đã kiểm chứng end-to-end trên site thật (không phải giả lập)

Chạy Chrome thật (`puppeteer-core` + `enableExtensions`) trên
một web phim Việt dùng HLS (phim hoạt hình, sub cháy tiếng Việt), bật OCR
qua đúng đường message thật (không gọi hàm nội bộ), để 45 giây:

- **8 câu đọc được, 151 lần quét nhẹ, 8 lần gọi OCR nặng, 0 lỗi, 0 kết quả rác**
- Câu đọc ra giữ đúng dấu tiếng Việt, kể cả dấu chồng
- Dịch báo đúng trạng thái `download-needed` khi model chưa tải (profile Chrome sạch)
- `SF_STATUS` phản ánh đúng số liệu cho popup ở mọi thời điểm

## Quyết định đã chốt (đừng mở lại nếu không có số liệu mới)

| Quyết định | Lý do |
|---|---|
| OCR trước, ASR sau | Sub đã cháy sẵn trong clip là **bản dịch người làm** — ASR không đọc được nó |
| Tesseract.js, không phải PaddleOCR | Hardsub dùng font họ Arial, đúng nhóm Tesseract mạnh (>97%). Giữ engine thay được để Phase 5 so sánh |
| Chrome Translator API, không phải transformers.js | Đã đo: dùng được ở offscreen → **0 byte** vendor thay vì ~75MB |
| Phần dịch đặt ở **offscreen document** | Translator API không chạy trong Web Worker; offscreen đã đo là chạy được |
| Overlay **chỉ hiện dòng tiếng Anh** | Tiếng Việt đã cháy sẵn trên hình, vẽ đè lên sẽ chồng chữ. Dữ liệu vẫn giữ cả hai để xuất `.srt` |
| Ngôn ngữ nguồn là **tham số**, mặc định `vi` | Để sau này gặp hardsub Trung/Hàn không phải sửa lõi |
| Track 1 (primary, TRÊN) = `TranslatedSource` (EN); track 2 (secondary, DƯỚI) = `OcrSource` (VI), **tắt mặc định** | Track 2 nằm gần đáy khung hình nhất — đúng chỗ hardsub gốc đang hiện. Bật `showVi` chỉ để đối chiếu OCR đọc đúng chưa |
| Mặt nạ chữ dùng **top-hat + hạt giống trắng tinh**, không phải Otsu/white-mask đơn thuần | Đo trên 22 khung thật: bản đầu (chỉ lọc sáng+viền tối) tô kín khe nền sáng (L≈238) kẹp giữa hai nét chữ, biến chữ thành khối đặc. Bắt buộc lõi phải **trắng tinh** (L≥~245, đo theo phân vị 98) mới nhận, rồi nở 1px lấy lại viền |
| `CueTracker` dùng ngưỡng chữ ký **chặt hơn ngay sau một lần quét trống** | Khung nhiễu (câu cũ rớt 1 lần rồi hiện lại y hệt) và chuyển cảnh (câu cũ rớt 1 lần rồi hiện câu **khác** cùng cỡ) chỉ phân biệt được bằng ngưỡng khác nhau ở đúng thời điểm đó |
| Cache cue vào **IndexedDB của trang** (không phải `chrome.storage`) | Content script có sẵn quyền, không cần bắc cầu message; khoá theo `href + duration` để không lẫn giữa các tập trong SPA không đổi URL |

## Kiểm chứng bằng cách chạy thật, không đoán

Thay đổi nào cũng được kiểm chứng bằng cách chạy thật, không chỉ đọc code.
Công cụ chính là **`puppeteer-core` + Chrome thật** (`enableExtensions: true`,
`browser.installExtension()`) — nạp ĐÚNG extension này, điều khiển qua CDP
để đọc console của content script / offscreen / service worker, gọi
`chrome.tabs.sendMessage` y hệt popup thật gọi. Đây là cách duy nhất kiểm
chứng được toàn tuyến (content script ↔ offscreen ↔ Tesseract ↔ Translator).

**Bài học riêng về `puppeteer-core` — đã tốn nhiều vòng debug:**

Content script gọi `chrome.runtime.sendMessage` luôn nhận `undefined`, dù gọi
trực tiếp cùng hàm từ service worker context (qua CDP) thì chạy được, và
`chrome.tabs.sendMessage` theo chiều ngược lại (như popup gọi) cũng chạy được.
Nguyên nhân: **profile Chrome (`userDataDir`) dùng lại xuyên suốt hàng chục lần
chạy** tích tụ đăng ký extension cũ — content script mới gắn vào một bản đăng
ký khác với service worker đang bị inspect. Đây là bug **môi trường test**,
không phải bug code. **Dùng profile mới cho mỗi lần chạy** khi test extension
bằng puppeteer — kiểm tra lại bằng `chrome.runtime.getContexts()` (đếm offscreen
document thật) chứ đừng chỉ tin log console, vì service worker MV3 ephemeral
khiến việc gắn CDP console-log vào nó không đáng tin.

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
| `tesseract.js` mặc định tạo worker qua blob URL bọc `importScripts(...)` | CSP của MV3 chặn → lỗi ném dưới dạng **chuỗi thuần** (không phải `Error`), `${err.name}: ${err.message}` cho ra `"undefined: undefined"` | `workerBlobURL: false` khi `Tesseract.createWorker(...)`; dùng `describeError()` (`src/core/errors.js`) để mô tả lỗi dù nó là kiểu gì |
| Truyền `logger: undefined` cho Tesseract | Ghi đè hàm mặc định của thư viện → `TypeError: m is not a function` lặp lại mỗi mốc tiến độ | Luôn truyền một hàm, kể cả rỗng: `logger: onProgress ?? (() => {})` |
| Mặt nạ chữ chỉ lọc "sáng + viền tối" (không đòi trắng tinh) | Khe nền sáng vừa (L≈238, ví dụ bầu trời/tường) kẹp giữa hai nét chữ cũng thoả điều kiện → bị tô kín, lỗ của `o/ô/ơ` biến mất, Tesseract đọc thành khối đặc | Bắt buộc hạt giống phải **trắng tinh** (ngưỡng tự thích nghi theo phân vị 98 độ sáng của ứng viên), rồi mới nở ra lấy viền |
| Bỏ qua thành phần liên thông, chỉ dùng khung bao của toàn bộ pixel "sáng có viền" | Vài mảnh tranh vẽ ở rìa khung kéo khung bao rộng ra hàng trăm pixel, OCR đọc luôn cả chúng | `components()` + `selectTextComponents()`: gom cụm theo dòng, chỉ giữ cụm nặng nhất mỗi dòng |
