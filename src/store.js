/* Stop The Slop - chrome.storage.local wrapper. */
globalThis.STS = globalThis.STS || {};
(function (STS) {
  'use strict';

  const VIDEO_TTL = 1000 * 60 * 60 * 24 * 7;   // re-score a video after a week
  const MAX_VIDEO_CACHE = 600;
  const MAX_VIDEOS_PER_CHANNEL = 20;

  const get = (keys) => new Promise((res) => chrome.storage.local.get(keys, res));
  const set = (obj) => new Promise((res) => chrome.storage.local.set(obj, res));

  async function settings() {
    const { settings: s } = await get('settings');
    return Object.assign({}, STS.score.DEFAULTS, s || {});
  }

  async function setSettings(patch) {
    const cur = await settings();
    const next = Object.assign({}, cur, patch);
    await set({ settings: next });
    return next;
  }

  async function channels() {
    const { channels: c } = await get('channels');
    return c || {};
  }

  async function handles() {
    const { handles: h } = await get('handles');
    return h || {};
  }

  /** Map "@somehandle" -> "UCxxxx" once we've seen both. */
  async function linkHandle(handle, channelId) {
    if (!handle || !channelId) return;
    const h = await handles();
    const key = String(handle).toLowerCase();
    if (h[key] === channelId) return;
    h[key] = channelId;
    await set({ handles: h });
  }

  /** Accepts a channelId or an @handle. */
  async function resolveId(key) {
    if (!key) return null;
    const k = String(key);
    if (/^UC[\w-]{22}$/.test(k)) return k;
    const h = await handles();
    return h[k.toLowerCase()] || null;
  }

  async function getChannel(key) {
    const id = await resolveId(key);
    if (!id) return null;
    const c = await channels();
    return c[id] || null;
  }

  async function putChannel(rec) {
    if (!rec || !rec.id) return null;
    const c = await channels();
    const prev = c[rec.id] || {};
    const merged = Object.assign({}, prev, rec, { updatedAt: Date.now() });
    c[rec.id] = merged;
    await set({ channels: c });
    if (merged.handle) await linkHandle(merged.handle, merged.id);
    return merged;
  }

  /** Record one scored video against its channel and re-aggregate. */
  async function recordVideo(channel, videoId, scored, settingsObj) {
    const c = await channels();
    const id = channel.id;
    const rec = c[id] || { id, name: channel.name, handle: channel.handle, videos: {}, manual: null };
    rec.name = channel.name || rec.name;
    rec.handle = channel.handle || rec.handle;
    rec.videos = rec.videos || {};
    rec.videos[videoId] = {
      total: scored.total,
      strong: scored.strong,
      sampled: scored.sampled,
      views: scored.views,
      title: channel.videoTitle,
      evidence: (scored.evidence || []).slice(0, 2),
      at: Date.now()
    };

    // Keep the newest N video observations only.
    const entries = Object.entries(rec.videos).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    rec.videos = Object.fromEntries(entries.slice(0, MAX_VIDEOS_PER_CHANNEL));

    const agg = STS.score.aggregate(Object.values(rec.videos), settingsObj);
    rec.score = agg.total;
    rec.verdict = agg.verdict;
    rec.n = agg.n;
    rec.worst = agg.worst;
    rec.evidence = agg.evidence;
    rec.updatedAt = Date.now();

    c[id] = rec;
    await set({ channels: c });
    if (rec.handle) await linkHandle(rec.handle, id);
    return rec;
  }

  async function setManual(key, value) {
    const id = await resolveId(key);
    if (!id) return null;
    const c = await channels();
    if (!c[id]) return null;
    c[id].manual = value || null;   // 'slop' | 'ok' | null
    c[id].updatedAt = Date.now();
    await set({ channels: c });
    return c[id];
  }

  async function removeChannel(key) {
    const id = await resolveId(key);
    if (!id) return;
    const c = await channels();
    delete c[id];
    await set({ channels: c });
  }

  /** Effective verdict, with a manual override taking priority over the score. */
  function effective(rec) {
    if (!rec) return 'unknown';
    if (rec.manual === 'slop') return 'slop';
    if (rec.manual === 'ok') return 'ok';
    return rec.verdict || 'unknown';
  }

  async function getVideo(videoId) {
    const { videos } = await get('videos');
    const v = (videos || {})[videoId];
    if (!v) return null;
    if (Date.now() - (v.at || 0) > VIDEO_TTL) return null;
    return v;
  }

  async function putVideo(videoId, data) {
    const { videos } = await get('videos');
    const v = videos || {};
    v[videoId] = Object.assign({}, data, { at: Date.now() });
    const entries = Object.entries(v).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    await set({ videos: Object.fromEntries(entries.slice(0, MAX_VIDEO_CACHE)) });
  }

  async function clearAll() {
    await new Promise((res) => chrome.storage.local.remove(['channels', 'handles', 'videos'], res));
  }

  STS.store = {
    settings, setSettings, channels, getChannel, putChannel, recordVideo,
    setManual, removeChannel, effective, resolveId, linkHandle,
    getVideo, putVideo, clearAll
  };
})(globalThis.STS);
