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
}

init();
