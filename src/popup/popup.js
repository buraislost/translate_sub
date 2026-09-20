import { getSettings, setSettings } from '../core/store.js';

const $ = (id) => document.getElementById(id);

let tabId = null;
let settings = null;

/* ------------------------------------------------------------------ */
/* Giao tiếp                                                           */
/* ------------------------------------------------------------------ */

/**
 * Gửi lệnh xuống content script.
 *
 * Vì content script chạy trong MỌI frame, Chrome sẽ broadcast tới tất cả
 * và trả về phản hồi ĐẦU TIÊN. Các frame không có video được lập trình để
 * im lặng, nên phản hồi nhận được luôn đến từ frame đang phát video —
 * nhờ vậy extension xử lý được cả video nhúng trong iframe mà không cần
 * thêm logic nào.
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
  if (!status?.hasVideo) {
    $('status').innerHTML =
      'Chưa tìm thấy video trên trang này. Hãy mở trang phim rồi bấm lại biểu tượng.';
    return;
  }

  const d = status.duration;
  const time = d
    ? `${String(Math.floor(d / 60)).padStart(2, '0')}:${String(Math.floor(d % 60)).padStart(2, '0')}`
    : '—';

  $('status').innerHTML =
    `Đã kết nối video <strong>${time}</strong> qua adapter <strong>${status.adapter}</strong>.` +
    `<div class="hint">Đang xem: nhấn <kbd>Shift</kbd>+<kbd>Z</kbd> hoặc <kbd>Shift</kbd>+<kbd>X</kbd> để chỉnh lệch 0,5 giây.</div>`;

  for (const i of [1, 2]) {
    const track = status.tracks[i];
    const btn = $(`pick${i}`);
    $(`name${i}`).textContent = track ? track.label : 'Chọn file .srt';
    $(`count${i}`).textContent = track ? `${track.count} dòng` : '';
    btn.classList.toggle('loaded', Boolean(track));

    const off = status.offsets[i] || 0;
    $(`off${i}`).textContent = `${off > 0 ? '+' : ''}${off.toFixed(1)}s`;
  }
}

/** Khung xem thử phản chiếu đúng cài đặt hiện tại. */
function renderPreview() {
  const scale = settings.fontSize / 26;
  $('previewA').style.fontSize = `${15 * scale}px`;
  $('previewB').style.fontSize = `${12.5 * scale}px`;
  document.querySelector('.stage').style.paddingBottom = `${6 + settings.bottom * 0.9}px`;

  $('fontSizeVal').textContent = `${settings.fontSize}`;
  $('bottomVal').textContent = `${settings.bottom}%`;
}

/* ------------------------------------------------------------------ */
/* Hành động                                                           */
/* ------------------------------------------------------------------ */

async function loadFile(index, file) {
  const content = await file.text();
  const status = await send({
    type: 'SF_LOAD_TRACK',
    index,
    content,
    label: file.name,
  });
  renderStatus(status);
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
  renderPreview();
  await send({ type: 'SF_SETTINGS', patch });
}

/* ------------------------------------------------------------------ */
/* Thăm dò kỹ thuật                                                    */
/* ------------------------------------------------------------------ */

/** Gửi message tới service worker (khác với send() ở trên — cái đó gửi tới tab). */
function sendToSw(message) {
  return chrome.runtime.sendMessage(message).catch((err) => ({ error: String(err) }));
}

const LANGS = { sourceLanguage: 'vi', targetLanguage: 'en' };

/**
 * Chạy cả hai phép thử chặn cửa và đổ kết quả ra màn hình.
 *
 * Translator API được thử ở BA context vì tài liệu Chrome chỉ nói rõ về
 * "top-level window"; offscreen document và service worker là vùng xám, phải
 * đo thực tế mới biết nên đặt phần dịch ở đâu.
 */
async function runProbe() {
  const btn = $('probeRun');
  btn.disabled = true;
  btn.textContent = 'Đang thử…';

  const [page, sw, offscreen] = await Promise.all([
    send({ type: 'SF_PROBE', langs: LANGS }),
    sendToSw({ type: 'SF_PROBE_TRANSLATOR_SW', target: 'sw', langs: LANGS }),
    sendToSw({ type: 'SF_PROBE_TRANSLATOR_OFFSCREEN', target: 'sw', langs: LANGS }),
  ]);

  renderProbe({ page, sw, offscreen });

  btn.disabled = false;
  btn.textContent = 'Chạy lại';
}

function renderProbe({ page, sw, offscreen }) {
  const out = $('probeOut');

  if (!page) {
    out.innerHTML = row(
      'Kết quả',
      '<span class="verdict bad">Không frame nào có video</span> — mở trang phim, bấm play rồi thử lại.'
    );
    return;
  }

  const t = page.taint;
  const items = [
    row('Trang', esc(page.hostname)),
    row('Nguồn video', esc(t.srcKind ?? '—')),
    row(
      'Đọc pixel',
      t.ok
        ? '<span class="verdict ok">ĐỌC ĐƯỢC</span> — OCR chạy được trên site này'
        : `<span class="verdict bad">KHÔNG ĐỌC ĐƯỢC</span><br>${esc(t.error ?? '')}`
    ),
  ];

  if (t.videoSize?.width) {
    items.push(row('Khung hình', `${t.videoSize.width} × ${t.videoSize.height}`));
  }
  if (t.hasDrm) {
    items.push(row('DRM', '<span class="verdict bad">Có</span> — OCR bất khả thi, không có cách lách'));
  }

  // Ba context, mỗi cái một dòng: cái nào xanh thì đặt phần dịch ở đó.
  for (const [label, res] of [
    ['Dịch · trang', page.translator],
    ['Dịch · offscreen', offscreen],
    ['Dịch · worker', sw],
  ]) {
    items.push(row(label, translatorVerdict(res)));
  }

  if (page.translator?.sample) {
    items.push(row('Câu thử', `→ ${esc(page.translator.sample)}`));
  }

  out.innerHTML = `<dl>${items.join('')}</dl>`;
}

function translatorVerdict(res) {
  if (!res || res.error) {
    return `<span class="bad">không dùng được</span> — ${esc(res?.error ?? 'không phản hồi')}`;
  }
  const map = {
    available: '<span class="verdict ok">SẴN SÀNG</span>',
    downloadable: '<span class="verdict warn">CẦN TẢI MODEL</span> — dùng được, Chrome tải lần đầu',
    downloading: '<span class="verdict warn">ĐANG TẢI</span>',
    unavailable: '<span class="verdict bad">KHÔNG HỖ TRỢ</span>',
  };
  return `${map[res.availability] ?? esc(String(res.availability))} <span style="color:var(--muted)">(${esc(res.api ?? '—')})</span>`;
}

const row = (label, value) => `<div class="item"><dt>${label}</dt><dd>${value}</dd></div>`;

/** Chặn HTML injection — kết quả probe có chứa URL và message lỗi từ trang web. */
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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
  renderPreview();

  renderStatus(await send({ type: 'SF_STATUS' }));

  $('enabled').addEventListener('change', (e) =>
    patchSettings({ enabled: e.target.checked })
  );
  $('fontSize').addEventListener('input', (e) =>
    patchSettings({ fontSize: +e.target.value })
  );
  $('bottom').addEventListener('input', (e) =>
    patchSettings({ bottom: +e.target.value })
  );

  for (const i of [1, 2]) {
    $(`pick${i}`).addEventListener('click', () => $(`file${i}`).click());
    $(`file${i}`).addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) loadFile(i, file);
    });
  }

  for (const btn of document.querySelectorAll('[data-nudge]')) {
    btn.addEventListener('click', () =>
      nudge(+btn.dataset.nudge, +btn.dataset.delta)
    );
  }

  $('probeRun').addEventListener('click', runProbe);
}

init();
