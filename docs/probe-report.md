# Báo cáo thăm dò — Phase 0

Hai phép thử chặn cửa, chạy **trước** khi viết pipeline OCR. Mục đích: kiểm chứng hai giả định mà toàn bộ hướng đi đang đặt cược vào, để nếu sai thì đổi kiến trúc ngay chứ không phải sau hai tuần.

Công cụ: `src/dev/probe.js`, chạy qua mục **Thăm dò kỹ thuật** trong popup.

> **Ghi chú sau này:** các công cụ thăm dò (`src/dev/`, `hardsub-detect.js`, mục "Thăm dò kỹ thuật") đã được gỡ khỏi repo khi dọn giao diện để công khai. Số liệu trong báo cáo này vẫn giữ nguyên; code gốc còn trong lịch sử git.

---

## Kết luận

| Giả định | Kết quả | Hệ quả |
|---|---|---|
| Đọc được pixel video trên web phim Việt | ✅ **Đúng** | OCR khả thi, đi tiếp theo kế hoạch |
| Dịch on-device bằng Chrome Translator API | ✅ **Đúng** (ở offscreen) | Bỏ được phương án transformers.js ~75MB |

**Cả hai cổng đều mở. Không cần đổi kiến trúc.**

---

## Phép thử 1 — canvas tainted

| Hạng mục | Kết quả |
|---|---|
| Site | `web phim A` |
| Adapter khớp | `universal` |
| Nguồn video | `blob (MSE/HLS)` |
| Khung hình | **1924 × 1040** |
| Thời lượng | 63:41 |
| `getImageData` | ✅ **Đọc được** |
| DRM | Không |

Đúng như dự đoán trong kế hoạch: web phim Việt phát qua HLS, video đến trình duyệt dưới dạng `blob:` URL qua Media Source Extensions. Nguồn `blob:` cùng origin nên **không làm canvas bị tainted** — khác hẳn `<video src>` trỏ thẳng sang CDN cross-origin.

### Hai điều rút ra

**1. `UniversalAdapter` là đủ.** Adapter khớp là `universal` và nó tìm đúng thẻ video. Chưa cần viết adapter riêng cho site phim nào.

**2. Không được giả định 16:9.** Khung hình **1924 × 1040** cho tỉ lệ ~1,85:1 (tỉ lệ điện ảnh), không phải 1920 × 1080. Vùng crop phải tính từ `videoWidth`/`videoHeight` thật lúc chạy, tuyệt đối không hardcode theo 16:9 — nếu không, vùng quét sẽ lệch khỏi dải phụ đề trên đúng loại phim ta nhắm tới.

### Còn phải đo thêm

Mới đo **một** site. Trước khi tin kết quả này là phổ quát, cần chạy probe trên ít nhất 2–3 site phim khác. Nếu gặp site tainted thì phương án dự phòng là `chrome.tabCapture`.

---

## Phép thử 2 — Chrome Translator API

Cặp ngôn ngữ thử: `vi` → `en`. API phát hiện được: **`Translator` (Chrome 138+)**.

| Context | Kết quả | Ghi chú |
|---|---|---|
| Content script (trang) | `downloadable` | Dùng được, Chrome tải model lần đầu |
| **Offscreen document** | `downloadable` | ✅ **Chỗ pipeline thật sẽ gọi** |
| Service worker | *chưa kết luận* | Xem bên dưới |

### Vì sao chọn offscreen

Tài liệu Chrome chỉ nói rõ Translator API chạy trong "top-level window" và **không** chạy trong Web Worker; offscreen document là vùng xám không được nêu. Phép thử này trả lời dứt điểm: **offscreen dùng được**.

Đó cũng là chỗ đúng về mặt kiến trúc — Tesseract WASM đằng nào cũng phải ở đó, nên OCR và dịch nằm chung một context, không phải bắc thêm cầu message.

### Dòng service worker: lỗi của probe, không phải của Chrome

```
TypeError: import() is disallowed on ServiceWorkerGlobalScope by the HTML specification
```

Đây **không** phải câu trả lời về Translator API — probe chết trước khi kịp kiểm tra. Nguyên nhân: `sw.js` dùng `import()` động, thứ mà spec HTML cấm trong service worker.

Đã sửa bằng **static import** (chạy được vì manifest khai báo `"type": "module"`). Kết quả sau khi sửa không ảnh hưởng quyết định kiến trúc — phần dịch đã chốt đặt ở offscreen.

### Trạng thái `downloadable`

Model chưa có sẵn trên máy. Hệ quả cho thiết kế:

- Lần dùng đầu tiên Chrome phải tải model → **bắt buộc có chỉ báo tiến độ**, không thì người dùng tưởng treo
- Chrome đòi **user gesture** để bắt đầu tải → nút tải phải nằm trong popup (cú click là gesture hợp lệ); offscreen document không bao giờ có gesture
- Tải xong một lần thì model dùng được ở **mọi** context, kể cả offscreen

---

## Việc tiếp theo

1. Bấm **"Tải model dịch & thử Việt → Anh"** trong popup → xác nhận chất lượng dịch và đo độ trễ mỗi câu
2. Chạy probe trên 2–3 site phim khác để xác nhận kết quả taint không phải may mắn
3. Nếu cả hai đạt → Phase 1: đóng gói Tesseract.js vào `vendor/`

---

# Khảo sát site thật — vòng 2

Chạy trực tiếp trên hai site thật, bằng cách tiêm code của dự án vào trang.

## web phim A — có video, **không có hardsub**

| Hạng mục | Kết quả |
|---|---|
| `<video>` ở document gốc | Có |
| Nguồn | `blob (MSE/HLS)` |
| Khung hình | 1924 × 1040 (~1,85:1) |
| `getImageData` | ✅ đọc được |
| DRM | Không |
| `textTracks` | 0 |
| Element phụ đề trong DOM | Không có |
| **Hardsub** | ❌ **Không có** |

Quét 23 mốc rải khắp tập phim 64 phút, đếm pixel "lõi sáng + viền tối":

- **20/23 mốc cho điểm 0**
- Cao nhất 77 trên ~140.000 mẫu = 0,055% — mức nhiễu
- Nhìn mắt 4 dải cắt ở 70–100% khung hình: **không có chữ nào**

Tesseract vẫn chạy và vẫn trả về chuỗi — nhưng là rác đọc từ nhiễu ảnh:

| Mốc | Confidence | Đọc ra |
|---|---|---|
| 905s | 46% | `` `. w- im ệ . `` |
| 1000s | 44% | `Lư, v.)N va »` |
| 1100s | 30% | `Ặ Si "ve : € \| 4 ; _. — 4 V-m Z 5 ¬>%` |

Server ghi **"Song Ngữ (Việt-Hàn-Anh)"** hoá ra là **chọn tiếng lồng**, không phải phụ đề.

**Hệ quả kiến trúc:** phải có bước kiểm tra hardsub TRƯỚC khi bật pipeline OCR → đã làm thành `src/core/hardsub-detect.js`.

## web phim B — player nằm trong iframe cross-origin

| Hạng mục | Kết quả |
|---|---|
| `<video>` ở document gốc | **Không có** (kể cả khi duyệt xuyên Shadow DOM) |
| Player | iframe → `máy chủ player khác tên miền` |
| `allow` của iframe | `autoplay; fullscreen` — **không có `translator`** |
| Truy cập từ trang cha | Bị chặn (cross-origin) |
| Chống debug | **Có** — mở devtools thì player tự chặn, trang chỉ còn 1120 ký tự |
| Video | Nằm sau cổng quảng cáo |

Ba điều rút ra:

1. **`all_frames: true` là bắt buộc, không phải tuỳ chọn.** Không có nó thì extension mù hoàn toàn trên site này.
2. **Quyết định đặt phần dịch ở offscreen là đúng.** Content script trong iframe cross-origin không gọi được Translator API vì iframe thiếu `allow="translator"` — mà ta không sửa được thuộc tính đó trên iframe của người khác.
3. **Cơ chế chống debug không cản extension**, chỉ cản việc soi bằng devtools. Content script chạy bình thường.

## Việc đã sửa từ hai khảo sát này

| Sửa | Vì sao |
|---|---|
| Thêm `src/core/hardsub-detect.js` + 8 test | Không có nó, extension OCR nhiễu hàng giờ mà không ai biết |
| Thêm nút "Phim này có sub cháy không?" | Hỏi trước một câu rẻ hơn chạy OCR cả tập. *(Sau này thay bằng gợi ý tự hiện trong trạng thái OCR khi quét ~15 giây không thấy chữ — khỏi phải tua video.)* |
| `getContainer()` đổi sang sai số **theo tỉ lệ** | Đo thật: video 531×299, ancestor cao 404 — chênh 105px, chỉ vừa thoát ngưỡng cứng 100px cũ. Quá sát ranh giới |
| Vùng crop lấy từ **số đo** thay vì hằng số | Khung 1924×1040 không phải 16:9 |
