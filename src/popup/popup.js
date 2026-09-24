import { getSettings, setSettings } from '../core/store.js';

const $ = (id) => document.getElementById(id);

const LANGS = { sourceLanguage: 'vi', targetLanguage: 'en' };

/**
 * Quét ~15 giây (150 lần × 100ms) mà chưa đọc được câu nào thì gần như chắc phim không
 * có sub cháy — thường là bản lồng tiếng. Báo sớm để người dùng khỏi ngồi chờ vô ích.
 */
const NO_TEXT_AFTER_SCANS = 150;

let tabId = null;
let settings = null;

/* ------------------------------------------------------------------ */
/* Giao tiếp                                                           */
/* ------------------------------------------------------------------ */

/**
 * Gửi lệnh xuống content script.
 *
 * Content script chạy trong MỌI frame nên Chrome broadcast tới tất cả và trả về phản
 * hồi ĐẦU TIÊN. Frame không có video được lập trình để im lặng, nên phản hồi luôn đến
 * từ frame đang phát video — nhờ vậy xử lý được cả video nhúng trong iframe.
 */
function send(message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      void chrome.runtime.lastError; // nuốt lỗi "no receiving end"
      resolve(response || null);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Hiển thị                                                            */
/* ------------------------------------------------------------------ */

function renderStatus(status) {
  const hasVideo = Boolean(status?.hasVideo);
  $('ocrToggle').disabled = !hasVideo;

  if (!hasVideo) {
    $('status').textContent = 'No video on this page — open a video and press play.';
    renderOcrStatus(null);
    return;
  }

  $('status').innerHTML =
    `Video <strong>${fmtDuration(status.duration)}</strong> · ` +
    `<kbd>Shift</kbd>+<kbd>Z</kbd> / <kbd>Shift</kbd>+<kbd>X</kbd> shift timing by 0.5 s`;

  for (const i of [1, 2]) {
    const track = status.tracks[i];
    $(`name${i}`).textContent = track ? track.label : 'Choose file';
    $(`count${i}`).textContent = track ? `${track.count} lines` : '';
    $(`pick${i}`).classList.toggle('loaded', Boolean(track));

    const off = status.offsets[i] || 0;
    $(`off${i}`).textContent = `${off > 0 ? '+' : ''}${off.toFixed(1)}s`;
  }

  renderOcrStatus(status.ocr);
}

/**
 * Trạng thái OCR. Mọi tình huống khiến người dùng nhìn màn hình trống đều phải được
 * báo rõ kèm cách xử lý, không được im lặng:
 *   - unreadable: video DRM/cross-origin, không có cách nào đọc hình
 *   - invalidated: extension vừa được nạp lại, content script cũ đã mồ côi
 *   - model dịch chưa tải: cần một cú bấm của người dùng, không tự tải được
 *   - quét mãi không thấy chữ: phim không có sub cháy
 */
function renderOcrStatus(ocr) {
  const on = Boolean(ocr?.on);
  $('ocrToggle').checked = on;
  $('ocrShowViRow').hidden = !on;
  const out = $('ocrStatus');
  out.hidden = !on;
  if (!on) return;

  $('ocrShowVi').checked = Boolean(ocr.showVi);

  if (ocr.unreadable) {
    out.innerHTML = '<span class="bad">Can’t read this video’s frames</span> — the site uses DRM or blocks access. There is no workaround.';
    return;
  }
  if (ocr.invalidated) {
    out.innerHTML = '<span class="bad">The extension was just updated</span> — reload the page, then turn this on again.';
    return;
  }

  const lines = [];
  const count = ocr.cueCount ?? 0;
  if (count > 0) {
    lines.push(`Read <strong>${count}</strong> ${count === 1 ? 'line' : 'lines'}`);
  } else if ((ocr.scans ?? 0) >= NO_TEXT_AFTER_SCANS) {
    lines.push('<span class="warn">No subtitles found on screen yet</span> — this may be a dubbed version. Try a version with subtitles burned into the video.');
  } else {
    lines.push('Looking for subtitles on screen…');
  }
  if (ocr.errors) lines.push(`<span class="warn">${ocr.errors} ${ocr.errors === 1 ? 'error' : 'errors'}</span>${ocr.lastError ? `: ${esc(ocr.lastError)}` : ''}`);

  const t = ocr.translate;
  if (t?.state === 'download-needed' || t?.state === 'downloading') {
    out.innerHTML =
      lines.join('<br>') +
      '<br><span class="warn">Translation model not downloaded</span> — a one-time download.' +
      '<button class="btn" id="downloadModel" type="button">Download translation model</button>';
    $('downloadModel').addEventListener('click', downloadModelThenRetry);
    return;
  }
  if (t?.state === 'unsupported' || t?.state === 'unavailable') {
    lines.push('<span class="bad">This browser can’t translate yet</span> — requires Chrome 138 or later.');
  } else if (t?.state === 'error') {
    lines.push(`<span class="warn">Translation error</span>: ${esc(t.message || '')}`);
  }

  out.innerHTML = lines.join('<br>');
}

function renderSliderValues() {
  $('fontSizeVal').textContent = `${settings.fontSize}`;
  $('bottomVal').textContent = `${settings.bottom}%`;
}

/* ------------------------------------------------------------------ */
/* Hành động                                                           */
/* ------------------------------------------------------------------ */

/**
 * Tải model dịch — PHẢI chạy trong popup vì Chrome đòi user gesture để bắt đầu tải
 * model AI on-device, và offscreen document (nơi thật sự gọi Translator) không bao giờ
 * có gesture. Tải xong một lần thì mọi context dùng chung.
 */
async function downloadModelThenRetry(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    const translator = await Translator.create({
      ...LANGS,
      monitor(m) {
        m.addEventListener('downloadprogress', (ev) => {
          btn.textContent = `Downloading… ${Math.round(ev.loaded * 100)}%`;
        });
      },
    });
    translator.destroy?.();
  } catch {
    // Trạng thái đọc lại ngay dưới đây sẽ hiện đúng lý do nếu tải thất bại.
  }
  // Các câu đọc được trong lúc chờ model đang xếp hàng — bảo content script dịch bù.
  renderStatus(await send({ type: 'SF_OCR_RETRY_TRANSLATE' }));
}

async function loadFile(index, file) {
  const content = await file.text();
  renderStatus(await send({ type: 'SF_LOAD_TRACK', index, content, label: file.name }));
}

async function nudge(index, delta) {
  const current = parseFloat($(`off${index}`).textContent) || 0;
  const value = +(current + delta).toFixed(2);
  const status = await send({ type: 'SF_SET_OFFSET', index, value });
  settings = await setSettings({ [`offset${index}`]: value });
  renderStatus(status);
}

async function patchSettings(patch) {
  settings = await setSettings(patch);
  renderSliderValues();
  await send({ type: 'SF_SETTINGS', patch });
}

/* ------------------------------------------------------------------ */
/* Tiện ích                                                            */
/* ------------------------------------------------------------------ */

/** Chặn HTML injection — thông báo lỗi có thể chứa chuỗi đến từ trang web. */
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function fmtDuration(d) {
  if (!d) return '—';
  const h = Math.floor(d / 3600);
  const mm = String(Math.floor((d % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(d % 60)).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* ------------------------------------------------------------------ */
/* Khởi động                                                           */
/* ------------------------------------------------------------------ */

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;

  settings = await getSettings();
  $('enabled').checked = settings.enabled;
  $('fontSize').value = settings.fontSize;
  $('bottom').value = settings.bottom;
  renderSliderValues();

  renderStatus(await send({ type: 'SF_STATUS' }));

  $('enabled').addEventListener('change', (e) => patchSettings({ enabled: e.target.checked }));
  $('fontSize').addEventListener('input', (e) => patchSettings({ fontSize: +e.target.value }));
  $('bottom').addEventListener('input', (e) => patchSettings({ bottom: +e.target.value }));

  $('ocrToggle').addEventListener('change', async (e) => {
    e.target.disabled = true;
    const status = e.target.checked
      ? await send({ type: 'SF_OCR_ENABLE', showVi: $('ocrShowVi').checked })
      : await send({ type: 'SF_OCR_DISABLE' });
    e.target.disabled = false;
    renderStatus(status);
  });

  $('ocrShowVi').addEventListener('change', async (e) => {
    renderStatus(await send({ type: 'SF_OCR_SET_SHOW_VI', showVi: e.target.checked }));
  });

  for (const i of [1, 2]) {
    $(`pick${i}`).addEventListener('click', () => $(`file${i}`).click());
    $(`file${i}`).addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) loadFile(i, file);
    });
  }

  for (const btn of document.querySelectorAll('[data-nudge]')) {
    btn.addEventListener('click', () => nudge(+btn.dataset.nudge, +btn.dataset.delta));
  }

  // OCR chạy nền trong content script — popup tự hỏi lại định kỳ để số liệu không
  // đứng yên trong lúc đang mở.
  setInterval(async () => {
    if (!document.hidden) renderStatus(await send({ type: 'SF_STATUS' }));
  }, 1500);
}

init();
