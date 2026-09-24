# Benchmark

Dữ liệu đo chứa khung hình và lời thoại của phim có bản quyền nên **chỉ giữ cục bộ**,
không commit (xem `.gitignore`):

- `fixtures/<bộ>/` — khung hình PNG cắt từ phim có hardsub
  - `<bộ>/` — khung CÓ phụ đề; `<bộ>-neg/` — khung KHÔNG có; `<bộ>-seq/` — chuỗi khung liên tiếp
- `ground-truth/<bộ>.json` — phụ đề chuẩn do người gõ tay cho từng khung
- `output/` — kết quả OCR/ASR sinh ra

Test dùng dữ liệu thật (`tests/preprocess.test.mjs`, `tests/cue-tracker.test.mjs`,
`tests/bytes.test.mjs`) tìm bộ `hardsub-a` và **tự bỏ qua** khi không có — clone về
chạy test vẫn xanh. Muốn chạy đủ thì tự cắt khung từ một phim hardsub bất kỳ theo
cấu trúc trên.

Xem kế hoạch chi tiết ở `docs/sprint-5-benchmark.md`.
