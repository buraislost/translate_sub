# Sprint 2 — ASR (nhận dạng tiếng nói)

**Mục tiêu**: sinh phụ đề từ audio cho video không có sub, chạy hoàn toàn trong browser.

**Định nghĩa "xong"**: mở một video YouTube đã tắt caption → bật SubForge → sau ≤ 30 giây có phụ đề chạy đúng nội dung, sai số thời gian dưới 1 giây, và **âm thanh vẫn phát bình thường**.

---

## Vì sao cần offscreen document

Service worker của MV3 không có DOM, không có `AudioContext`, và bị kill sau ~30 giây idle. ASR cần cả ba thứ đó. `chrome.offscreen` tạo một trang HTML ẩn có đầy đủ DOM API.

```
Content script          Service worker          Offscreen document
(trong trang web)       (điều phối)             (DOM ẩn)
      │                       │                        │
 captureStream()              │                        │
 resample 16kHz ──── PCM ────►│───── PCM ─────────────►│
      │                       │                   Worker: Whisper
      │◄──── cue ─────────────│◄──── cue ──────────────│
 render overlay
```

**Quyết định kỹ thuật**: lấy audio bằng `videoEl.captureStream()` ở content script, **không** dùng `chrome.tabCapture`. Lý do:

| | `captureStream()` | `chrome.tabCapture` |
|---|---|---|
| Chỉ báo "đang chia sẻ tab" | Không hiện | Hiện — làm người dùng lo |
| Âm thanh người dùng nghe | Không bị chiếm | Bị chiếm, phải tự nối lại |
| Video có DRM | Không lấy được | Cũng không lấy được |
| Video trong iframe cross-origin | Lấy được (content script chạy trong frame đó) | Lấy được cả tab |

Giữ `tabCapture` làm phương án dự phòng khi `captureStream()` thất bại.

---

## Nhiệm vụ

### T2.1 — Dựng offscreen document

**File mới**: `src/offscreen/offscreen.html`, `src/offscreen/offscreen.js`

- Thêm `"offscreen"` vào `permissions` trong manifest
- Trong `sw.js`: hàm `ensureOffscreen()` gọi `chrome.offscreen.createDocument({ url, reasons: ['USER_MEDIA'], justification })`
- Chrome chỉ cho phép **một** offscreen document tại một thời điểm → phải kiểm tra tồn tại trước bằng `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })`
- Heartbeat: khi ASR đang chạy, `sw.js` gọi một message rỗng mỗi 20 giây để service worker không bị kill

**Xong khi**: `console.log` từ offscreen.js xuất hiện trong DevTools của service worker.

### T2.2 — Lấy audio và resample

**File mới**: `src/core/audio.js`, `src/offscreen/pcm-worklet.js`

```js
// pcm-worklet.js — chạy trên audio thread, không block UI
class PCMCollector extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('pcm-collector', PCMCollector);
```

- `new AudioContext({ sampleRate: 16000 })` — Whisper yêu cầu đúng 16kHz mono, `Float32Array`, biên độ `[-1, 1]`
- **Bắt buộc**: `source.connect(ctx.destination)` — nếu quên, người dùng mất tiếng hoàn toàn
- `ScriptProcessorNode` đã deprecated, không dùng

**Xong khi**: log được độ dài buffer PCM tăng dần, và tai vẫn nghe thấy tiếng video.

### T2.3 — VAD cắt chunk theo câu

**Thư viện**: `@ricky0123/vad-web` (bọc sẵn model Silero VAD chạy ONNX, ~2MB) → tải về `vendor/vad/`

So sánh ba chiến lược cắt:

| Cách | Trễ | Chất lượng | Chọn |
|---|---|---|---|
| Cắt cứng 30s | 30s | Cắt giữa từ → mất chữ | ❌ |
| Cắt cứng + overlap 2s | 30s | Phải dedup phần chồng | ❌ |
| **VAD** | 2–5s | Cắt đúng chỗ im lặng → câu trọn vẹn | ✅ |

Logic: gom PCM vào buffer → cắt khi VAD báo im lặng > 400ms **hoặc** buffer đạt 25 giây (chặn trên, tránh câu quá dài).

**Xong khi**: log ra danh sách chunk với độ dài 2–25 giây, ranh giới rơi vào chỗ im lặng.

### T2.4 — Whisper worker

**Thư viện**: `@huggingface/transformers` → tải về `vendor/transformers/`

```js
const asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
  device: 'webgpu',   // tự fallback 'wasm'
  dtype: 'q8',
});

const out = await asr(float32Chunk, {
  language: 'vietnamese',
  task: 'transcribe',
  return_timestamps: true,
});
```

| Model | Dung lượng | Tốc độ WASM | Tiếng Việt |
|---|---|---|---|
| `whisper-tiny` | ~40 MB | Nhanh nhất | Kém, nhiều lỗi |
| `whisper-base` | ~80 MB | Vừa | Chấp nhận được ← mặc định |
| `whisper-small` | ~250 MB | Chậm, cần WebGPU | Tốt |

Cho người dùng chọn model trong popup, mặc định `base`.

**Điểm thuận lợi**: Whisper trả timestamp tương đối trong chunk → chỉ cần cộng thời điểm bắt đầu chunk là ra thời gian tuyệt đối. Không cần thuật toán căn chỉnh nào.

**Xong khi**: một chunk audio 10 giây trả về text kèm timestamp hợp lý.

### T2.5 — `WhisperSource`

**File mới**: `src/sources/WhisperSource.js`

- Kế thừa `SubtitleSource`
- `start()` mở AudioContext + worklet + kết nối offscreen
- Mỗi kết quả Whisper → `this._emit({ start, end, text })`
- `stop()` đóng stream, terminate worker, giải phóng AudioContext

**Ba chế độ chạy** (cho người dùng chọn):

| Chế độ | Cách hoạt động | Dùng khi |
|---|---|---|
| **Prepare** | Quét trước toàn bộ, lưu IndexedDB rồi mới xem | Máy yếu, phim có sẵn ← khuyến nghị |
| **Live** | Chấp nhận trễ 3–8 giây | Máy có WebGPU |
| **Adaptive** | Tự pause video khi buffer sub cạn | Không muốn mất chữ |

**Xong khi**: bật `WhisperSource` làm track 2, phụ đề hiện trên video.

### T2.6 — UI và cache

- Popup: thêm lựa chọn nguồn cho mỗi track (`File` / `Nhận dạng tiếng nói`), chọn model, chọn chế độ
- Hiện tiến độ tải model (lần đầu tải 80MB, không có chỉ báo thì người dùng tưởng treo)
- Cache cue vào IndexedDB theo hash của `location.href + video.duration`
- Nút xuất `.srt` (hàm `toSrt()` trong `parser.js` đã có sẵn)

**Xong khi**: xem lại cùng video lần hai thì sub hiện ngay, không chạy lại Whisper.

---

## Thứ tự làm và kiểm tra

Làm tuần tự T2.1 → T2.6. Sau mỗi nhiệm vụ phải **chạy thử trong Chrome thật** rồi mới sang bước kế tiếp — đây là code chạm vào phần cứng (audio, GPU), không test tự động thay thế được.

Nếu một bước hỏng, dừng lại đọc log lỗi thay vì đoán mò sang bước sau.

## Repo tham khảo

| Repo | Xem phần nào |
|---|---|
| `Sora-bluesky/x-jimaku` | `captureStream()` + resample + stream sang offscreen |
| `xignoe/videoTranslatorExtenstion` | Cấu trúc offscreen + Whisper worker, README liệt kê cạm bẫy |
| `ainoya/chrome-extension-web-transcriptor-ai` | Bản tối giản nhất, dễ đọc |
| `pramodh567/localsub` | `offscreen.ts` giữ nguyên âm thanh ra loa |
