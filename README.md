# Translate Sub

**Real-time translation of burned-in subtitles on any web video, using on-device OCR — no server.**

A Chrome extension that **reads subtitles burned into a web video (hardsub) and shows a translation in another language** on top of it, in real time. Everything runs on your machine: OCR with Tesseract (WebAssembly), translation with Chrome's built-in on-device Translator. No server, no API key, nothing is uploaded.

It can also play **two `.srt` files at once** (e.g. two languages stacked) on any page with a `<video>`.

> **Languages:** the first supported pair is **Vietnamese → English**. More source and target languages are on the way; see [Languages](#languages).

## Features

- **Hardsub OCR → translation.** Detects when a new subtitle line appears, reads it, translates it and draws the translation above the original. The translated line shows up about **0.1 s** after the original appears on screen.
- **Works on most sites.** The extension targets the page's `<video>` element, not a specific site. Fullscreen is supported.
- **Cached per episode.** Lines already read are saved in the page's IndexedDB. On a second viewing they load instantly, with no delay.
- **Optional original line.** You can show the OCR'd original line under the translation to check what was read.
- **Two subtitle files.** Load a top and a bottom `.srt`, nudge each one's timing, and change the size and position.

## Requirements

- Chrome **138 or later** for translation, because it uses the [Translator API](https://developer.chrome.com/docs/ai/translator-api). OCR alone works on older versions.
- About 8 MB of library files in `vendor/`. They are not committed; see the next section.

## Install

There is no build step and no `npm install`.

### 1. Get the code

```bash
git clone https://github.com/buraislost/translate_sub.git
cd translate_sub
```

### 2. Download the OCR files into `vendor/tesseract/`

| File | Source |
|---|---|
| `tesseract.esm.min.js` | https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js |
| `worker.min.js` | https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js |
| `tesseract-core-simd-lstm.wasm.js` | https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js |
| `tesseract-core-relaxedsimd-lstm.wasm.js` | https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-relaxedsimd-lstm.wasm.js |
| `vie.traineddata` (Vietnamese OCR model) | https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/vie.traineddata |

Run from the `translate_sub` folder:

```bash
mkdir -p vendor/tesseract && cd vendor/tesseract
curl -LO https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js
curl -LO https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js
curl -LO https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js
curl -LO https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-relaxedsimd-lstm.wasm.js
curl -LO https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/vie.traineddata
```

Why local copies? Manifest V3 blocks loading scripts and WebAssembly from a CDN. Use the **uncompressed** `.traineddata`, not the `.gz` version. Each source language needs its own `.traineddata` file from the same repository (e.g. `chi_sim`, `kor`, `jpn`) once that language is supported.

### 3. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `translate_sub` folder (the one containing `manifest.json`).

After pulling updates, click the reload icon on the extension card.

## Usage

1. Open a video that has subtitles burned into the picture in a supported language (currently Vietnamese), and start playing it.
2. Click the Translate Sub icon and turn on **Read subtitles & translate to English**.
3. The first time, the popup offers **Download translation model**. Click it once; Chrome keeps the model for that language pair.
4. Size and position sliders adjust the overlay.

To play two subtitle files instead, open **Load subtitles from an .srt file** in the popup. Loading a file turns off subtitle reading. `Shift`+`Z` and `Shift`+`X` shift the file timing by 0.5 s, and they also work in fullscreen.

## How it works

```
content script (in the video page)          offscreen document
──────────────────────────────────          ──────────────────
every 100 ms: scan the bottom band of the   build a clean black-on-white
frame at half resolution (~1.3 ms)          text mask (top-hat + white-seed
  │                                         + connected components)
  └─ new line? ── grayscale crop ─────────▶ Tesseract (source lang) ─▶ Chrome Translator
                                                    │
overlay (Shadow DOM) ◀──────── original + translated cue
```

- **Two tiers.** The cheap scan runs constantly, but the expensive OCR runs only when the subtitle's shape changes, which is about once per line rather than once per frame.
- **Preprocessing matters more than the engine.** On 22 hand-labelled real frames, Tesseract on raw frames scored a character error rate of **0.65**. On the preprocessed mask it scored **0.031**.
- **Latency.** The first version lagged about 1.2 s because Chrome throttles async canvas work in hidden offscreen documents. Images are now handed to Tesseract as PGM built in plain JS. Measured on the same 60 s clip (17 lines):

| | Before | After |
|---|---|---|
| Original line (Vietnamese), mean | 1219 ms | ~91–150 ms |
| Translated line (English), mean | 1234 ms | ~108–175 ms |
| Lines caught | 15 / 17 | 17 / 17 |

## Languages

| Source (burned-in) | Translation | Status |
|---|---|---|
| Vietnamese | English | ✅ Supported, measured on real video |
| Vietnamese | Other languages | 🚧 Planned |
| Other languages (e.g. Chinese, Korean, Japanese, English) | English, Vietnamese, … | 🚧 Planned |

**Already language-independent:** the pipeline passes the language as a parameter end to end. That covers the OCR language in `OcrSource`, and `from`/`to` in `TranslatedSource` and the offscreen services.

**Still needed for a new pair:**

1. **Language picker.** The popup needs source/target selectors. `src/main.js` currently fixes `vie` / `vi → en`.
2. **OCR model.** Add the matching Tesseract `.traineddata` to `vendor/tesseract/`.
3. **Tuning for other scripts.** Chinese, Japanese and Korean may need a different Tesseract page-segmentation mode and different text-cleaning rules. The current rules in `src/core/text-utils.js` are tuned for Latin script with diacritics.
4. **Translator support.** Check that Chrome's Translator API offers the pair. You can test with `Translator.availability({ sourceLanguage, targetLanguage })`.
5. **Measurement.** Label a few real frames and measure the error rate, as was done for Vietnamese.

Contributions for new languages are welcome.

## Limitations

- **DRM video** (Netflix, Disney+, …) cannot be read. Chrome blanks those frames for every extension.
- **Cross-origin players without CORS** also block frame access. The popup says so when it happens.
- **Resolution.** 720p and above works well. Below about 540p accuracy drops noticeably, and 360p is not readable.
- **Languages.** Only Vietnamese → English works today; see [Languages](#languages) for what is planned. Translation quality depends on Chrome's on-device model for each pair.
- **Dubbed versions** have no burned-in text to read. After a while with nothing found, the popup says so.
- **Live reading.** Each line appears shortly after the original, not before it. Cached lines on a rewatch have no delay.

## Development

```bash
node --test "tests/**/*.test.mjs"    # or: npm test
```

- The tests use only `node:test`, with no dependencies.
- Tests that need real video frames look for local fixtures in `benchmark/fixtures/`. They skip themselves when the fixtures are absent; see [benchmark/README.md](benchmark/README.md).
- The code is plain ES modules loaded directly by Chrome.
- Identifiers are in English. **Code comments and design notes are in Vietnamese.** [docs/NOTES.md](docs/NOTES.md) describes the architecture, the decisions made and the pitfalls already hit.

Layout:

- `src/content.js`, `src/main.js`: content script and page orchestration.
- `src/core/`: scanning, masking, cue tracking, overlay and sync. These are pure functions where possible.
- `src/sources/`: subtitle sources (`.srt` file, OCR, translated), all behind a single `SubtitleSource` interface.
- `src/offscreen/`: Tesseract and Translator, which run outside the page.
- `src/adapters/`: per-site hooks for finding the video and its fullscreen container.

## License

[MIT](LICENSE). The bundled OCR files you download into `vendor/` come from [Tesseract.js](https://github.com/naptha/tesseract.js) and [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), both under the Apache License 2.0.
