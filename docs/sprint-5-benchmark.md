# Sprint 5 — Đo đạc và ablation study

**Mục tiêu**: biến project từ "một extension chạy được" thành "một project có số liệu chứng minh".

Đây là sprint quan trọng nhất cho hồ sơ Data Scientist. Một câu như *"Otsu binarization giảm CER từ 0,24 xuống 0,11"* có giá trị hơn cả trang mô tả tính năng.

---

## Metric

| Metric | Dùng cho | Công thức |
|---|---|---|
| **CER** (Character Error Rate) | OCR | `levenshtein(hyp, ref) / len(ref)` tính theo ký tự |
| **WER** (Word Error Rate) | ASR | như trên nhưng tính theo từ |

Cả hai đều dựa trên khoảng cách Levenshtein — hàm này đã viết ở Sprint 3 (`src/core/postprocess.js`), dùng lại chứ không viết lại.

Chuẩn hoá trước khi so sánh (áp dụng giống nhau cho cả `hyp` lẫn `ref`, và ghi rõ trong báo cáo):

- Đưa về chữ thường
- Chuẩn hoá Unicode về `NFC` — tiếng Việt có hai cách mã hoá dấu, không chuẩn hoá thì `"à"` tổ hợp và `"à"` dựng sẵn bị tính là khác nhau
- Bỏ dấu câu và khoảng trắng thừa

---

## Test set

**Phải gõ tay.** Bước này không tự động hoá được.

- 5 clip, mỗi clip 3–5 phút, khoảng 40 câu → tổng ~200 câu
- Đa dạng có chủ đích: font chữ khác nhau, nền sáng/tối, có/không viền chữ, giọng Bắc/Nam
- Lưu dạng `.srt` chuẩn trong `benchmark/ground-truth/`
- Kèm `benchmark/clips.md` ghi nguồn từng clip và lý do chọn

Không có test set thì mọi con số sau đây đều vô nghĩa.

---

## Nhiệm vụ

### T5.1 — Hạ tầng đo

**File mới**: `benchmark/score.mjs`

```bash
node benchmark/score.mjs --ref benchmark/ground-truth/clip1.srt \
                         --hyp benchmark/output/clip1-ocr.srt \
                         --metric cer
```

- Đọc hai file `.srt`, căn theo thời gian, tính CER/WER
- In bảng theo từng clip + tổng hợp
- Xuất `benchmark/results.json` để bước vẽ biểu đồ dùng lại

### T5.2 — Ablation study cho OCR

Bật/tắt từng bước tiền xử lý, đo CER:

| Cấu hình | Upscale | Grayscale | Otsu | Invert | Morph close | CER |
|---|---|---|---|---|---|---|
| Baseline (không xử lý gì) | ✗ | ✗ | ✗ | ✗ | ✗ | ? |
| + grayscale | ✗ | ✓ | ✗ | ✗ | ✗ | ? |
| + ngưỡng cố định 128 | ✗ | ✓ | ✗ | ✓ | ✗ | ? |
| + Otsu thay ngưỡng cố định | ✗ | ✓ | ✓ | ✓ | ✗ | ? |
| + upscale 2× | ✓ | ✓ | ✓ | ✓ | ✗ | ? |
| Đầy đủ | ✓ | ✓ | ✓ | ✓ | ✓ | ? |

Mục đích: chứng minh **từng** bước đóng góp bao nhiêu, thay vì nói chung chung "có tiền xử lý thì tốt hơn".

### T5.3 — Ablation study cho ASR

| Biến | Các mức | Đo |
|---|---|---|
| Model | tiny / base / small | WER + thời gian xử lý |
| Cách cắt chunk | cố định 30s / overlap 2s / VAD | WER |
| Thiết bị | WASM / WebGPU | thời gian xử lý |

Vẽ biểu đồ **WER theo thời gian xử lý** — đường đánh đổi (trade-off curve) giữa độ chính xác và tốc độ, để thấy mỗi model phải trả giá bao nhiêu.

### T5.4 — Biểu đồ và báo cáo

**File mới**: `benchmark/plot.py`, `docs/BENCHMARK.md`

- Dùng `matplotlib`, đọc `results.json`
- Ba biểu đồ: ablation OCR (cột), WER theo model (cột), WER theo thời gian xử lý (đường)
- `BENCHMARK.md` viết theo cấu trúc: phương pháp → test set → kết quả → thảo luận → hạn chế

**Phần "hạn chế" bắt buộc phải có và phải thành thật.** Ví dụ: test set chỉ 200 câu, chỉ tiếng Việt, chỉ 5 phim, không đại diện cho mọi loại font. Thừa nhận giới hạn là dấu hiệu của người làm nghiên cứu nghiêm túc, không phải điểm yếu.

---

## Liên hệ với công việc Data Scientist

Quy trình của sprint này:

| Việc trong sprint | Tên gọi trong ngành |
|---|---|
| Gõ tay 200 câu ground truth | Data labeling / annotation |
| Chuẩn hoá NFC, bỏ dấu câu | Data preprocessing |
| CER / WER | Model evaluation metrics |
| Bật/tắt từng bước rồi đo | Ablation study |
| WER theo thời gian xử lý | Trade-off analysis |
| Phần "hạn chế" | Limitations / threats to validity |

Toàn bộ pipeline của project cũng là một **multi-modal ML pipeline** hoàn chỉnh: Computer Vision (OCR) → Speech Processing (ASR) → NLP (dịch máy). Ba mảng lớn trong một project, và đều là inference thật chứ không phải gọi API.
