# Translate Sub

Chrome extension that reads hardcoded subtitles off a video and shows a translation on top of it. OCR and translation both run locally (Tesseract.js + Chrome's built-in Translator), nothing goes to a server.

Only Vietnamese -> English for now. Planning to add more languages later.

## Setup

Needs Chrome 138+ (for the Translator API).

```bash
git clone https://github.com/buraislost/translate_sub.git
cd translate_sub
mkdir -p vendor/tesseract && cd vendor/tesseract
curl -LO https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js
curl -LO https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js
curl -LO https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js
curl -LO https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-relaxedsimd-lstm.wasm.js
curl -LO https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/vie.traineddata
```

`vendor/` isn't in the repo. MV3 doesn't allow loading scripts from a CDN, so the Tesseract files have to sit locally.
Then go to `chrome://extensions`, turn on Developer mode, Load unpacked and pick the folder.

## Usage
Open a video with burned-in subs, click the extension icon and turn on "Read subtitles & translate to English". The first time it asks you to download the translation model.
You can also just load `.srt` files instead. Shift+Z / Shift+X shifts the timing by 0.5s.

## Notes
- Scans the bottom of the frame every 100ms and only runs OCR when the line changes, it shows up ~0.1s after the sub appears
- Doesn't work on DRM video (Netflix,...) or players in a cross-origin iframe
- Accuracy drops a lot below ~540p.
- More details in [docs/NOTES.md](docs/NOTES.md) (in Vietnamese, same as the code comments)

## Tests
```bash
npm test
```

## License
MIT. The Tesseract files are Apache 2.0.
