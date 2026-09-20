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

/* ------------------------------------------------------------------ */
/* Tải model dịch                                                      */
/* ------------------------------------------------------------------ */

/**
 * Câu thử — cố tình nhồi dấu chồng (ề, ể, ệ, ừ, ữ) và văn nói kiểu phụ đề.
 * Vừa để xem chất lượng dịch, vừa làm mẫu đối chiếu khi OCR đọc sai dấu:
 * nếu dịch ra tiếng Anh vô nghĩa thì gần như chắc chắn dấu đã sai từ khâu OCR.
 */
const SAMPLES = [
  'Hôm nay trời đẹp quá!',
  'Chiều nay trời đẹp, về nhà nghỉ một chút nhé.',
  'Tôi đã nghĩ kỹ rồi, chuyện này không thể để lâu hơn nữa.',
];

/**
 * Tải model dịch rồi dịch thử.
 *
 * Vì sao chạy trong popup chứ không phải offscreen: Chrome đòi user gesture
 * để bắt đầu tải model AI on-device. Cú click ở đây là gesture hợp lệ, còn
 * offscreen document thì không bao giờ có. Tải xong một lần là model dùng
 * được ở MỌI context — kể cả offscreen, nơi pipeline thật sẽ gọi nó.
 */
async function runModel() {
  const btn = $('modelRun');
  const out = $('modelOut');
  btn.disabled = true;

  const show = (html) => {
    out.innerHTML = `<dl>${html}</dl>`;
  };

  try {
    if (typeof Translator?.availability !== 'function') {
      show(row('Lỗi', '<span class="verdict bad">Không có Translator API</span> — cần Chrome 138+'));
      return;
    }

    const state = await Translator.availability(LANGS);
    if (state === 'unavailable') {
      show(row('Lỗi', '<span class="verdict bad">Chrome không hỗ trợ cặp vi → en</span>'));
      return;
    }

    btn.textContent = state === 'available' ? 'Đang dịch thử…' : 'Đang tải model…';

    const translator = await Translator.create({
      ...LANGS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          // e.loaded là tỉ lệ 0–1, không phải số byte.
          btn.textContent = `Đang tải model… ${Math.round(e.loaded * 100)}%`;
        });
      },
    });

    btn.textContent = 'Đang dịch thử…';

    // Dịch tuần tự, KHÔNG Promise.all: Translator API xử lý từng cái một,
    // gọi song song chỉ xếp hàng ngầm và khó đo thời gian thật.
    const rows = [];
    for (const vi of SAMPLES) {
      const t0 = performance.now();
      const en = await translator.translate(vi);
      const ms = Math.round(performance.now() - t0);
      rows.push(
        row(`${ms} ms`, `<span style="color:var(--muted)">${esc(vi)}</span><br>→ ${esc(en)}`)
      );
    }
    translator.destroy?.();

    show(rows.join(''));
    btn.textContent = 'Dịch thử lại';
  } catch (err) {
    show(row('Lỗi', `<span class="verdict bad">${esc(err.name)}</span> ${esc(err.message)}`));
    btn.textContent = 'Thử lại';
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Self-test OCR                                                       */
/* ------------------------------------------------------------------ */

/**
 * Nạp Tesseract rồi cho nó đọc mấy ảnh tự vẽ có đáp án biết trước.
 *
 * Đây là câu trả lời cho câu hỏi lớn nhất của Phase 1: Tesseract có đọc nổi
 * dấu tiếng Việt không. Nếu CER ở điều kiện lý tưởng đã tệ thì trên phim thật
 * còn tệ hơn nhiều — và phải đổi engine TRƯỚC khi viết pipeline quanh nó.
 */
async function runOcr() {
  const btn = $('ocrRun');
  const out = $('ocrOut');
  btn.disabled = true;
  btn.textContent = 'Đang nạp Tesseract (~3,9MB)…';
  out.innerHTML = '';

  const res = await sendToSw({ type: 'SF_OCR_SELFTEST', target: 'sw', lang: 'vie' });

  if (!res?.ok) {
    out.innerHTML = `<dl>${row('Lỗi', `<span class="verdict bad">${esc(res?.error ?? 'không phản hồi')}</span>`)}</dl>`;
    btn.disabled = false;
    btn.textContent = 'Thử lại';
    return;
  }

  // CER dưới 0,10 ở điều kiện lý tưởng là đạt; trên 0,30 là phải đổi engine.
  const verdict =
    res.meanCer <= 0.1
      ? '<span class="verdict ok">ĐẠT</span>'
      : res.meanCer <= 0.3
        ? '<span class="verdict warn">TẠM ĐƯỢC</span>'
        : '<span class="verdict bad">KÉM</span>';

  const rows = [
    row('Nạp engine', `${res.initMs} ms`),
    row('CER trung bình', `<strong>${res.meanCer}</strong> ${verdict}`),
  ];

  for (const r of res.results) {
    if (r.error) {
      rows.push(row(esc(r.label), `<span class="bad">${esc(r.error)}</span>`));
      continue;
    }
    // Hiện cả câu đúng lẫn câu đọc được: con số CER cho biết tệ đến đâu,
    // nhưng nhìn chữ mới biết SAI Ở ĐÂU — thường là dấu thanh.
    const tone = r.cer <= 0.05 ? 'ok' : r.cer <= 0.2 ? 'warn' : 'bad';
    rows.push(
      row(
        esc(r.label),
        `<span class="${tone}">CER ${r.cer}</span> · ${r.confidence}% · ${r.ms} ms` +
          `<br><span style="color:var(--muted)">${esc(r.expected)}</span>` +
          `<br>→ ${esc(r.got)}`
      )
    );
  }

  out.innerHTML = `<dl>${rows.join('')}</dl>`;
  btn.disabled = false;
  btn.textContent = 'Thử OCR lại';
}

/* ------------------------------------------------------------------ */
/* Phim này có sub cháy không                                          */
/* ------------------------------------------------------------------ */

/**
 * Quét rải khắp phim xem có phụ đề cháy trên hình không.
 *
 * Vì sao đáng có nút riêng: đo thật trên một web phim Việt cho thấy có phim
 * KHÔNG có hardsub (server ghi "Song Ngữ" hoá ra là chọn tiếng lồng). Chạy OCR
 * trên phim như vậy chỉ cho ra chuỗi rác đọc từ nhiễu ảnh — tốn CPU hàng giờ
 * mà người dùng không hiểu vì sao. Hỏi trước một câu rẻ hơn nhiều.
 */
async function runHardsub() {
  const btn = $('hardsubRun');
  const out = $('hardsubOut');
  btn.disabled = true;
  btn.textContent = 'Đang tua và quét 12 khung hình…';
  out.innerHTML = '';

  const r = await send({ type: 'SF_PROBE_HARDSUB', samples: 12 });

  if (!r || r.error) {
    const msg = esc(r?.error ?? 'không tìm thấy video trên trang này');
    out.innerHTML = '<dl>' + row('Lỗi', '<span class="verdict bad">' + msg + '</span>') + '</dl>';
    btn.disabled = false;
    btn.textContent = 'Thử lại';
    return;
  }

  const verdict =
    r.hasHardsub === true
      ? '<span class="verdict ok">CÓ SUB CHÁY</span> — OCR dùng được'
      : r.hasHardsub === false
        ? '<span class="verdict bad">KHÔNG CÓ SUB CHÁY</span> — OCR sẽ chỉ đọc ra chuỗi rác'
        : '<span class="verdict warn">CHƯA CHẮC</span>';

  const rows = [
    row('Kết luận', verdict),
    row('Căn cứ', esc(r.reason)),
    row('Khung hình', esc(r.frame)),
  ];

  // Vùng crop ĐO ĐƯỢC tốt hơn hẳn con số mặc định đoán mò: đã gặp phim
  // 1924x1040 (~1,85:1), giả định 16:9 sẽ cắt lệch khỏi dải chữ.
  if (r.cropHint) {
    rows.push(
      row('Dải chữ', r.cropHint.topPct + '% – ' + r.cropHint.bottomPct + '% chiều cao khung')
    );
  }

  out.innerHTML = '<dl>' + rows.join('') + '</dl>';
  btn.disabled = false;
  btn.textContent = 'Quét lại';
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
  $('modelRun').addEventListener('click', runModel);
  $('ocrRun').addEventListener('click', runOcr);
  $('hardsubRun').addEventListener('click', runHardsub);
}

init();
