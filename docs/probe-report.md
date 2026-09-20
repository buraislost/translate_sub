# Báo cáo thăm dò — Phase 0

Hai phép thử chặn cửa, chạy **trước** khi viết pipeline OCR. Mục đích: kiểm chứng hai giả định mà toàn bộ hướng đi đang đặt cược vào, để nếu sai thì đổi kiến trúc ngay chứ không phải sau hai tuần.

Công cụ: [`src/dev/probe.js`](../src/dev/probe.js), chạy qua mục **Thăm dò kỹ thuật** trong popup.

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
