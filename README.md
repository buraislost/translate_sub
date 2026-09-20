# SubForge

Extension hiển thị **hai phụ đề song song** trên bất kỳ website nào có thẻ `<video>`.

Trạng thái: **Sprint 1 hoàn tất** — nạp phụ đề từ file, hiển thị overlay, đồng bộ theo video, chỉnh lệch thời gian.

---

## Cài và chạy

Không cần `npm install`, không có bước build.

1. Mở `chrome://extensions`
2. Bật **Developer mode** (góc trên bên phải)
3. Bấm **Load unpacked** → chọn thư mục `subforge`
4. Mở một trang phim bất kỳ, bấm biểu tượng extension
5. Chọn file `.srt` cho "Dòng trên" và "Dòng dưới"

Chạy test:

```bash
npm test
```

Không cần `npm install` — script chỉ gọi `node --test`, không có dependency nào.

---

## Phím tắt

| Phím | Tác dụng |
|---|---|
| `Shift` + `Z` | Phụ đề chậm lại 0,5 giây |
| `Shift` + `X` | Phụ đề nhanh lên 0,5 giây |

Hoạt động cả khi đang xem toàn màn hình — đó là lý do có phím tắt thay vì chỉ có nút trong popup.

---

## Kiến trúc

```
manifest.json
src/
  content.js            loader — dynamic import để dùng ES module trong content script
  main.js               điều phối: tìm video → gắn overlay → nhận lệnh
  sw.js                 service worker (Sprint 2 sẽ dùng cho offscreen + tabCapture)

  core/
    SubtitleSource.js   ★ contract chung cho mọi nguồn phụ đề
    parser.js           SRT/VTT → cue; chuẩn hoá; xuất ngược ra SRT
    renderer.js         overlay trong Shadow DOM, xử lý fullscreen
    sync.js             vòng lặp rAF, tra cue bằng binary search
    store.js            chrome.storage cho settings và phiên làm việc

  sources/
    SrtFileSource.js    nguồn từ file upload

  adapters/
    base.js             contract nền tảng + deepQuerySelectorAll (xuyên Shadow DOM)
    universal.js        fallback — chạy trên mọi site có <video>
    youtube.js          ví dụ adapter riêng
    registry.js         chọn adapter theo URL

  popup/                giao diện điều khiển
tests/                  test chạy bằng node, không framework
docs/                   kế hoạch chi tiết từng sprint
benchmark/              test set và script đo CER/WER
docs/NOTES.md           ghi chú kiến trúc, quyết định, cạm bẫy
```

### Hai trục mở rộng

**Trục nguồn phụ đề** — mọi nguồn đều implement `SubtitleSource`:

```js
class SubtitleSource {
  async init(videoEl) {}
  async start() {}
  async stop() {}
  onCue(fn) {}
  cueAt(time) {}   // binary search, O(log n)
}
```

Thêm OCR hay ASR = thêm một class, **không sửa** Renderer hay SyncEngine.

**Trục nền tảng** — mọi site đều implement `BaseAdapter`:

```js
class BaseAdapter {
  static match(url) {}
  getVideo() {}
  getContainer() {}
  hideNativeSubs() {}
}
```

Thêm site mới = thêm file ~30 dòng vào `adapters/`, đăng ký vào `registry.js`.

---

## Những chỗ đã xử lý sẵn

| Vấn đề | Cách giải |
|---|---|
| CSS của trang phá overlay | Toàn bộ overlay nằm trong Shadow DOM |
| Overlay biến mất khi fullscreen | Gắn vào container của video; nghe `fullscreenchange` để di chuyển |
| Video nằm trong iframe | `all_frames: true`; frame không có video tự im lặng khi nhận message |
| Video nằm trong Shadow DOM | `deepQuerySelectorAll` duyệt đệ quy qua mọi shadow root |
| SPA đổi video không reload | `MutationObserver` + debounce 300ms |
| File `.srt` lỗi định dạng | Parser bám vào dòng `-->`, tự sắp xếp, tự sửa cue lỗi |
| Tra cue tốn CPU | Binary search thay vì quét tuyến tính |
| Nạp lại phụ đề sau khi F5 | Lưu phiên theo hostname, đối chiếu thời lượng video |

---

## Lộ trình

| Sprint | Nội dung | Trạng thái |
|---|---|---|
| 1 | Xương sống + `SrtFileSource` + overlay + offset | ✅ xong |
| 2 | ASR: offscreen, AudioWorklet 16kHz, Whisper, VAD | ⬜ [kế hoạch](docs/sprint-2-asr.md) |
| 3 | OCR: canvas, Otsu binarize, dHash, Tesseract.js | ⬜ [kế hoạch](docs/sprint-3-ocr.md) |
| 4 | Dịch máy bằng `transformers.js`, cache IndexedDB | ⬜ |
| 5 | Đo CER/WER, ablation study | ⬜ [kế hoạch](docs/sprint-5-benchmark.md) |

### Bắt đầu một sprint

Việc tiếp theo: `docs/sprint-2-asr.md`, bắt đầu từ T2.1.
`docs/NOTES.md` chứa ràng buộc kiến trúc và danh sách cạm bẫy đã biết.

---

## Nguồn tham khảo

| Repo | Dùng để |
|---|---|
| `xignoe/videoTranslatorExtenstion` | Mẫu offscreen + Whisper worker |
| `Sora-bluesky/x-jimaku` | Cách lấy audio từ video element |
| `ainoya/chrome-extension-web-transcriptor-ai` | Bản ASR tối giản, dễ đọc |
| `apm1467/videocr` | Thuật toán OCR: `conf_threshold=65`, `sim_threshold=90`, crop nửa dưới |
| `timminator/VideOCR` | PaddleOCR + SSIM phát hiện thay đổi frame |
| `jeromewu/tesseract.js-chrome-extension` | Cách đóng gói WASM + traineddata vào extension |
