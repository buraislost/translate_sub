/**
 * main.js — bộ điều phối phía trang web.
 *
 * Vòng đời:
 *   pickAdapter → chờ <video> xuất hiện → gắn Renderer → chạy SyncEngine
 *                 → lắng nghe lệnh từ popup và phím tắt
 *
 * Chạy trong MỌI frame (all_frames: true) nên phải chịu được việc không có
 * video — đa số frame quảng cáo rơi vào trường hợp này.
 */

import { pickAdapter } from './adapters/registry.js';
import { Renderer } from './core/renderer.js';
import { SyncEngine } from './core/sync.js';
import { SrtFileSource } from './sources/SrtFileSource.js';
import { OcrSource } from './sources/OcrSource.js';
import { TranslatedSource } from './sources/TranslatedSource.js';
import { OffscreenClient } from './core/offscreen-client.js';
import { cueCacheKey, loadCueCache, saveCueCache } from './core/idb-cache.js';
import { getSettings, saveSession, loadSession } from './core/store.js';

const HOST = location.hostname;

const state = {
  adapter: pickAdapter(),
  video: null,
  renderer: null,
  sync: null,
  settings: null,
  labels: { 1: null, 2: null },
  offscreen: new OffscreenClient(),
  /** @type {OcrSource|null} */
  ocr: null,
  /** @type {TranslatedSource|null} */
  translated: null,
  /** { on: boolean, showVi: boolean } */
  ocrMode: { on: false, showVi: false },
  _ocrSaveOff: null,
};

/** Gọi `fn` chỉ sau khi ngừng bị gọi tiếp trong `ms` — tránh ghi cache mỗi cue. */
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ */
/* Khởi tạo                                                            */
/* ------------------------------------------------------------------ */

async function boot() {
  state.settings = await getSettings();
  observeVideo();
}

/**
 * Chờ và theo dõi thẻ video.
 *
 * Không dùng setInterval vì hai lý do: tốn tài nguyên khi trang không có
 * video, và phản ứng chậm khi video xuất hiện. MutationObserver bắn đúng
 * lúc DOM đổi — cũng chính là cơ chế bắt việc chuyển tập trên SPA.
 */
function observeVideo() {
  let scheduled = false;

  const check = () => {
    scheduled = false;
    const video = state.adapter.getVideo();

    if (!video) {
      if (state.video) teardown();
      return;
    }
    if (video === state.video) return;

    setup(video);
  };

  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    // Gom nhiều thay đổi DOM liên tiếp thành một lần kiểm tra.
    setTimeout(check, 300);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  check();
}

async function setup(video) {
  teardown();

  state.video = video;
  state.renderer = new Renderer();
  state.renderer.attach(state.adapter.getContainer());
  state.renderer.applySettings(state.settings);
  state.renderer.setVisible(state.settings.enabled);

  state.sync = new SyncEngine(video, state.renderer);
  state.sync.setOffset(1, state.settings.offset1);
  state.sync.setOffset(2, state.settings.offset2);
  state.sync.start();

  state.adapter.hideNativeSubs();
  await restoreSession();
}

function teardown() {
  disableOcrInternal();
  state.sync?.stop();
  state.renderer?.destroy();
  state.adapter.restoreNativeSubs();
  state.sync = null;
  state.renderer = null;
  state.video = null;
}

/* ------------------------------------------------------------------ */
/* OCR + dịch — đọc sub cháy trên hình, hiện lại bằng tiếng Anh          */
/* ------------------------------------------------------------------ */

/**
 * Bố cục hai dòng cố ý LỆCH với thứ tự "track 1 = trên" thông thường của app:
 *
 *   track 1 (primary, to hơn, NẰM TRÊN)   → bản dịch tiếng Anh
 *   track 2 (secondary, nhỏ hơn, nằm dưới) → nguyên văn tiếng Việt OCR — TẮT theo
 *                                            mặc định, vì dòng này gần đáy khung hình
 *                                            nhất, ngay chỗ sub cháy sẵn đang hiện.
 *
 * Nếu bật showVi, người xem sẽ thấy CẢ hai: tiếng Việt do extension đọc ra đứng ngay
 * trên tiếng Việt cháy sẵn (dùng để kiểm tra OCR đọc đúng chưa) và tiếng Anh trên
 * cùng. Mặc định tắt vì phần lớn người dùng không cần nhìn lại bản tiếng Việt.
 */
async function enableOcr({ showVi = false } = {}) {
  if (!state.video) return false;
  disableOcrInternal();

  const ocr = new OcrSource({ client: state.offscreen, lang: 'vie' });
  await ocr.init(state.video);
  const translated = new TranslatedSource(ocr, { client: state.offscreen, from: 'vi', to: 'en' });

  const duration = state.video.duration;
  if (duration) {
    const cached = await loadCueCache(cueCacheKey(location.href, duration));
    if (cached?.records?.length) {
      ocr.restore(cached.records);
      translated.restore(cached.records);
      state.renderer?.toast(`Loaded ${cached.records.length} saved lines`);
    }
  }

  state.ocr = ocr;
  state.translated = translated;
  state.ocrMode = { on: true, showVi };

  await ocr.start();
  await translated.start();

  state.sync?.setTrack(1, translated);
  state.sync?.setTrack(2, showVi ? ocr : null);

  // Lưu cue định kỳ — không lưu mỗi cue một lần vì phim dài sẽ ghi IndexedDB liên tục.
  state._ocrSaveOff = ocr.onChange(debounce(persistOcrCache, 4000));

  persistSession();
  return true;
}

/** Dừng và giải phóng, KHÔNG đổi state.ocrMode hay lưu session — dùng nội bộ. */
function disableOcrInternal() {
  state._ocrSaveOff?.();
  state._ocrSaveOff = null;
  state.ocr?.stop();
  state.translated?.stop();
  state.ocr = null;
  state.translated = null;
}

async function disableOcr() {
  await persistOcrCache();
  disableOcrInternal();
  state.ocrMode = { on: false, showVi: false };
  state.sync?.setTrack(1, null);
  state.sync?.setTrack(2, null);
  persistSession();
}

async function persistOcrCache() {
  if (!state.ocr || !state.video?.duration) return;
  const records = exportCueRecords(state.ocr, state.translated);
  if (!records.length) return;
  await saveCueCache(cueCacheKey(location.href, state.video.duration), records);
}

/** Gộp cue tiếng Việt (OCR) và bản dịch khớp với nó thành bản ghi để lưu/khôi phục. */
function exportCueRecords(ocr, translated) {
  return ocr.cues.map((c) => {
    const t = translated?.cues.find((tc) => tc.source === c);
    return { start: c.start, end: c.end, vi: c.text, en: t ? t.text : null, top: c.topFrac ?? null };
  });
}

/* ------------------------------------------------------------------ */
/* Phiên làm việc                                                      */
/* ------------------------------------------------------------------ */

/**
 * Nạp lại phụ đề đã dùng lần trước trên cùng site.
 * Điều kiện: thời lượng video lệch dưới 2 giây so với lần lưu — tránh việc
 * áp nhầm phụ đề của tập 1 sang tập 2.
 */
async function restoreSession() {
  const saved = await loadSession(HOST);
  if (!saved) return;

  const duration = state.video?.duration;
  if (saved.duration && duration && Math.abs(saved.duration - duration) > 2) return;

  for (const index of [1, 2]) {
    const track = saved[`track${index}`];
    if (!track?.content) continue;
    applyTrack(index, track.content, track.label, false);
  }

  // Sau file track — nếu OCR đang bật ở lần xem trước, nó đè lên track 1/2 vì đó
  // đúng là trạng thái người dùng để lại lúc rời trang.
  if (saved.ocrMode?.on) await enableOcr({ showVi: Boolean(saved.ocrMode.showVi) });
}

async function persistSession() {
  await saveSession(HOST, {
    duration: state.video?.duration || null,
    track1: state.labels[1],
    track2: state.labels[2],
    ocrMode: state.ocrMode,
  });
}

function applyTrack(index, content, label, persist = true) {
  // Người dùng chọn nạp file nghĩa là không muốn OCR nữa. Dùng phần dọn dẹp ĐỒNG BỘ
  // (không phải disableOcr() — bản đó có await ở đầu, gọi mà không chờ sẽ tạo race:
  // setTrack(index, source) bên dưới chạy trước, rồi disableOcr mới dọn xong sau và
  // xoá mất track vừa gán).
  if (state.ocrMode.on) {
    persistOcrCache(); // để chạy nền, không cần chờ
    disableOcrInternal();
    state.ocrMode = { on: false, showVi: false };
    state.sync?.setTrack(1, null);
    state.sync?.setTrack(2, null);
  }

  const source = SrtFileSource.fromText(content, label);
  state.sync?.setTrack(index, source);
  state.labels[index] = { label, content, count: source.cues.length };
  if (persist) persistSession();
  return source.cues.length;
}

/* ------------------------------------------------------------------ */
/* Giao tiếp với popup                                                 */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Frame không có video thì im lặng, nhường quyền trả lời cho frame có video.
  if (!state.video) return;

  switch (msg.type) {
    case 'SF_STATUS':
      sendResponse(buildStatus());
      return true;

    case 'SF_LOAD_TRACK': {
      const count = applyTrack(msg.index, msg.content, msg.label);
      state.renderer?.toast(`Loaded ${count} lines`);
      sendResponse(buildStatus());
      return true;
    }

    case 'SF_CLEAR_TRACK':
      state.sync?.setTrack(msg.index, null);
      state.labels[msg.index] = null;
      persistSession();
      sendResponse(buildStatus());
      return true;

    case 'SF_SET_OFFSET':
      state.sync?.setOffset(msg.index, msg.value);
      sendResponse(buildStatus());
      return true;

    case 'SF_SETTINGS':
      state.settings = { ...state.settings, ...msg.patch };
      state.renderer?.applySettings(state.settings);
      if ('enabled' in msg.patch) state.renderer?.setVisible(msg.patch.enabled);
      sendResponse(buildStatus());
      return true;

    case 'SF_OCR_ENABLE':
      enableOcr({ showVi: Boolean(msg.showVi) }).then(() => sendResponse(buildStatus()));
      return true;

    case 'SF_OCR_DISABLE':
      disableOcr().then(() => sendResponse(buildStatus()));
      return true;

    // Chỉ đổi track 2 có hiện hay không — KHÔNG khởi động lại OcrSource/TranslatedSource.
    // Khởi động lại sẽ mất vài giây nạp lại engine và lãng phí cue vừa đọc được.
    case 'SF_OCR_SET_SHOW_VI':
      if (state.ocrMode.on) {
        state.ocrMode = { ...state.ocrMode, showVi: Boolean(msg.showVi) };
        state.sync?.setTrack(2, state.ocrMode.showVi ? state.ocr : null);
        persistSession();
      }
      sendResponse(buildStatus());
      return true;

    // Gọi sau khi người dùng đã tải xong model dịch trong popup — các cue đọc được
    // trong lúc chờ tải bị TranslatedSource xếp vào hàng lỗi, giờ thử lại.
    case 'SF_OCR_RETRY_TRANSLATE':
      state.translated?.retry();
      sendResponse(buildStatus());
      return true;
  }
});

function buildStatus() {
  return {
    hasVideo: Boolean(state.video),
    adapter: state.adapter.constructor.id,
    duration: state.video?.duration || 0,
    tracks: {
      1: state.labels[1] ? { label: state.labels[1].label, count: state.labels[1].count } : null,
      2: state.labels[2] ? { label: state.labels[2].label, count: state.labels[2].count } : null,
    },
    offsets: {
      1: state.sync?.getOffset(1) ?? 0,
      2: state.sync?.getOffset(2) ?? 0,
    },
    ocr: state.ocr
      ? {
          on: true,
          showVi: state.ocrMode.showVi,
          cueCount: state.ocr.cues.length,
          ...state.ocr.info,
          translate: state.translated?.status ?? null,
        }
      : { on: false },
  };
}

/* ------------------------------------------------------------------ */
/* Phím tắt                                                            */
/* ------------------------------------------------------------------ */

/**
 * Shift+Z / Shift+X chỉnh lệch cả hai track cùng lúc 0.5 giây.
 * Chỉnh offset là thao tác dùng LIÊN TỤC khi đang xem, bắt người dùng mở
 * popup mỗi lần là phá trải nghiệm — nhất là khi đang toàn màn hình.
 */
document.addEventListener(
  'keydown',
  (e) => {
    if (!state.sync || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;

    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

    const key = e.key.toLowerCase();
    const delta = key === 'z' ? -0.5 : key === 'x' ? 0.5 : 0;
    if (!delta) return;

    e.preventDefault();
    for (const index of [1, 2]) {
      state.sync.setOffset(index, +(state.sync.getOffset(index) + delta).toFixed(2));
    }
    const value = state.sync.getOffset(1);
    state.renderer?.toast(`Offset ${value > 0 ? '+' : ''}${value.toFixed(1)}s`);
  },
  true
);

boot();
