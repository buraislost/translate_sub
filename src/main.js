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
import { getSettings, saveSession, loadSession } from './core/store.js';

const HOST = location.hostname;

const state = {
  adapter: pickAdapter(),
  video: null,
  renderer: null,
  sync: null,
  settings: null,
  labels: { 1: null, 2: null },
};

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
  state.sync?.stop();
  state.renderer?.destroy();
  state.adapter.restoreNativeSubs();
  state.sync = null;
  state.renderer = null;
  state.video = null;
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
}

async function persistSession() {
  await saveSession(HOST, {
    duration: state.video?.duration || null,
    track1: state.labels[1],
    track2: state.labels[2],
  });
}

function applyTrack(index, content, label, persist = true) {
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
  if (!state.video && msg.type !== 'SF_PING') return;

  switch (msg.type) {
    case 'SF_STATUS':
      sendResponse(buildStatus());
      return true;

    case 'SF_LOAD_TRACK': {
      const count = applyTrack(msg.index, msg.content, msg.label);
      state.renderer?.toast(`Đã nạp ${count} dòng`);
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

    // Phép thử chặn cửa — chỉ dùng lúc phát triển. Nạp động để code thăm dò
    // không nằm trong đường chạy chính.
    case 'SF_PROBE':
      runProbe(msg.langs).then(sendResponse);
      return true;
  }
});

async function runProbe(langs) {
  const { probeTaint, probeTranslator } = await import(
    chrome.runtime.getURL('src/dev/probe.js')
  );
  return {
    url: location.href,
    hostname: location.hostname,
    adapter: state.adapter.constructor.id,
    taint: probeTaint(state.video),
    translator: await probeTranslator(langs),
  };
}

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
    state.renderer?.toast(`Lệch ${value > 0 ? '+' : ''}${value.toFixed(1)}s`);
  },
  true
);

boot();
