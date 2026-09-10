/* Stop The Slop - runs on youtube.com. */
(function (STS) {
  'use strict';

  const LABEL = { slop: 'SLOP', suspect: 'SUSPECT', ok: 'CLEAR', unknown: '?' };
  const state = { settings: null, current: null, busy: false };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function settings() {
    if (!state.settings) state.settings = await STS.store.settings();
    return state.settings;
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) state.settings = null;
    if (changes.channels) scheduleDecorate();
  });

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* ---------------------------------------------------------------- scoring */

  async function scoreVideo(videoId, force, opts) {
    const s = await settings();
    const isShort = !!(opts && opts.isShort);
    if (!force) {
      const cached = await STS.store.getVideo(videoId);
      if (cached) return cached;
    }
    const raw = await STS.tube.inspectVideo(videoId, s.commentSample);
    const scored = STS.score.scoreVideo(raw, s);
    const rec = {
      videoId: videoId,
      views: raw.views,
      commentCount: raw.commentCount,
      commentsDisabled: raw.commentsDisabled,
      title: raw.title,
      channelId: raw.channelId,
      channelName: raw.channelName,
      handle: raw.handle,
      scored: scored
    };
    await STS.store.putVideo(videoId, rec);
    // Shorts pull huge views with few comments, so folding them into a channel
    // average would drag every channel toward "slop". Score, but don't record.
    if (raw.channelId && !isShort) {
      await STS.store.recordVideo(
        { id: raw.channelId, name: raw.channelName, handle: raw.handle, videoTitle: raw.title },
        videoId,
        Object.assign({ views: raw.views }, scored),
        s
      );
    }
    return rec;
  }

  async function scanChannel(key, onProgress) {
    const s = await settings();
    const info = await STS.tube.channelVideos(key, s.scanDepth);
    const results = [];
    for (let i = 0; i < info.videoIds.length; i++) {
      try {
        results.push(await scoreVideo(info.videoIds[i], false));
      } catch (e) { /* one bad video shouldn't kill the scan */ }
      if (onProgress) onProgress(i + 1, info.videoIds.length);
      await sleep(350); // be polite to youtube
    }
    let id = info.channelId;
    if (!id) {
      const withId = results.find((r) => r.channelId);
      id = withId ? withId.channelId : await STS.store.resolveId(key);
    }
    if (!id) return null;
    await STS.store.putChannel({
      id: id,
      name: info.name || (results[0] || {}).channelName,
      handle: info.handle
    });
    return await STS.store.getChannel(id);
  }

  /* ------------------------------------------------------------- watch page */

  function videoIdFromUrl() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  async function handleWatch() {
    const id = videoIdFromUrl();
    if (!id) { state.current = null; return; }
    const s = await settings();
    if (!s.autoScan || state.busy) return;
    state.busy = true;
    try {
      const rec = await scoreVideo(id, false, { isShort: location.pathname.startsWith('/shorts/') });
      state.current = rec;
      const ch = rec.channelId ? await STS.store.getChannel(rec.channelId) : null;
      renderWatchBadge(rec, ch);
      try {
        chrome.runtime.sendMessage({
          type: 'sts-verdict',
          verdict: ch ? STS.store.effective(ch) : rec.scored.verdict,
          score: ch && Number.isFinite(ch.score) ? ch.score : rec.scored.total
        });
      } catch (_) {}
    } catch (e) {
      console.debug('[Stop The Slop]', e);
    } finally {
      state.busy = false;
    }
  }

  function renderWatchBadge(rec, ch) {
    const owner = document.querySelector('ytd-watch-metadata #owner') ||
                  document.querySelector('#owner');
    if (!owner) return;
    const old = document.getElementById('sts-watch-badge');
    if (old) old.remove();

    const verdict = ch ? STS.store.effective(ch) : rec.scored.verdict;
    const score = ch && Number.isFinite(ch.score) ? ch.score : rec.scored.total;
    if (verdict === 'unknown') return;

    const el = document.createElement('button');
    el.className = 'sts-badge sts-' + verdict;
    el.id = 'sts-watch-badge';
    el.title = 'Stop The Slop - click for the breakdown';
    el.textContent = LABEL[verdict] + (Number.isFinite(score) ? ' ' + score : '');
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(rec, ch, el);
    });
    const sub = owner.querySelector('#subscribe-button');
    if (sub) owner.insertBefore(el, sub);
    else owner.appendChild(el);
  }

  /* ----------------------------------------------------------------- panel */

  function bar(label, value) {
    const w = document.createElement('div');
    w.className = 'sts-bar';
    const v = Number.isFinite(value) ? value : 0;
    w.innerHTML = '<div class="sts-bar-label"><span>' + escapeHtml(label) + '</span><span>' +
      (Number.isFinite(value) ? value : 'n/a') + '</span></div>' +
      '<div class="sts-bar-track"><div class="sts-bar-fill" style="width:' + v + '%"></div></div>';
    return w;
  }

  function actionBtn(text, fn) {
    const b = document.createElement('button');
    b.className = 'sts-act';
    b.textContent = text;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
    return b;
  }

  function togglePanel(rec, ch, anchor) {
    const existing = document.getElementById('sts-panel');
    if (existing) { existing.remove(); return; }

    const p = document.createElement('div');
    p.id = 'sts-panel';
    p.className = 'sts-panel';

    const verdict = ch ? STS.store.effective(ch) : rec.scored.verdict;
    const score = ch && Number.isFinite(ch.score) ? ch.score : rec.scored.total;
    const sc = rec.scored;

    const h = document.createElement('div');
    h.className = 'sts-panel-head';
    h.innerHTML = '<span class="sts-badge sts-' + verdict + '">' + LABEL[verdict] +
      (Number.isFinite(score) ? ' ' + score : '') + '</span>' +
      '<span class="sts-panel-title">' + escapeHtml(rec.channelName || 'This channel') + '</span>';
    p.appendChild(h);

    const bars = document.createElement('div');
    bars.className = 'sts-bars';
    bars.appendChild(bar('Dead comment section', sc.ratioPoints));
    bars.appendChild(bar('Commenters calling it AI', sc.commentPoints));
    p.appendChild(bars);

    const ul = document.createElement('ul');
    ul.className = 'sts-notes';
    for (const n of sc.notes || []) {
      const li = document.createElement('li');
      li.textContent = n;
      ul.appendChild(li);
    }
    if (ch && ch.n > 1) {
      const li = document.createElement('li');
      li.textContent = 'Channel average across ' + ch.n + ' videos seen: ' + ch.score + '.';
      ul.appendChild(li);
    }
    if (ch && ch.manual) {
      const li = document.createElement('li');
      li.textContent = 'You marked this channel "' + ch.manual + '" by hand.';
      ul.appendChild(li);
    }
    p.appendChild(ul);

    const ev = (ch && ch.evidence && ch.evidence.length ? ch.evidence : sc.evidence) || [];
    if (ev.length) {
      const box = document.createElement('div');
      box.className = 'sts-evidence';
      const hd = document.createElement('div');
      hd.className = 'sts-evidence-h';
      hd.textContent = 'What commenters said';
      box.appendChild(hd);
      for (const e of ev.slice(0, 4)) {
        const q = document.createElement('div');
        q.className = 'sts-quote';
        q.textContent = '“' + e.text + '”';
        box.appendChild(q);
      }
      p.appendChild(box);
    }
    buildActions(p, rec);
    place(p, anchor);
  }

  function buildActions(p, rec) {
    const acts = document.createElement('div');
    acts.className = 'sts-acts';
    acts.appendChild(actionBtn('Scan channel', async (btn) => {
      btn.disabled = true;
      btn.textContent = 'Scanning…';
      try {
        await scanChannel(rec.channelId || rec.handle, (i, n) => {
          btn.textContent = 'Scanning ' + i + '/' + n;
        });
        p.remove();
        await handleWatch();
      } catch (e) { btn.textContent = 'Scan failed'; }
    }));
    acts.appendChild(actionBtn('Mark slop', async () => {
      if (rec.channelId) {
        await STS.store.setManual(rec.channelId, 'slop');
        p.remove();
        await handleWatch();
      }
    }));
    acts.appendChild(actionBtn('Mark fine', async () => {
      if (rec.channelId) {
        await STS.store.setManual(rec.channelId, 'ok');
        p.remove();
        await handleWatch();
      }
    }));
    p.appendChild(acts);
  }

  function place(p, anchor) {
    document.body.appendChild(p);
    const r = anchor.getBoundingClientRect();
    p.style.top = (window.scrollY + r.bottom + 8) + 'px';
    p.style.left = Math.max(8, Math.min(window.innerWidth - 380, r.left)) + 'px';
    setTimeout(() => {
      document.addEventListener('click', function off(e) {
        if (!p.contains(e.target)) { p.remove(); document.removeEventListener('click', off); }
      });
    }, 0);
  }

  /* ------------------------------------------------- scanning what you see */

  const CARD_SEL = [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer',
    'ytd-grid-video-renderer', 'ytd-playlist-video-renderer', 'yt-lockup-view-model'
  ].join(',');

  const cardCache = new WeakMap();   // card element -> {key, videoId, isShort}
  const observed = new WeakSet();    // cards already handed to the observer
  const pending = new Set();         // channel keys queued or in flight
  const failed = new Set();          // keys that errored - don't retry this page load
  const queue = [];
  let workerRunning = false;
  let scansThisSession = 0;

  function pageChannelKey() {
    const m = location.pathname.match(/^\/(@[\w.\-]+)/) ||
              location.pathname.match(/^\/channel\/(UC[\w-]{22})/);
    if (!m) return null;
    return m[1].charAt(0) === '@' ? m[1].toLowerCase() : m[1];
  }

  function keyFromHref(href) {
    const ch = String(href || '').match(/^\/channel\/(UC[\w-]{22})/);
    if (ch) return ch[1];
    const h = String(href || '').match(/^\/(@[\w.\-]+)/);
    return h ? h[1].toLowerCase() : null;
  }

  /** Channel + video a feed card points at. */
  function cardInfo(card) {
    const hit = cardCache.get(card);
    if (hit) return hit;

    let key = null;
    const links = card.querySelectorAll('a[href^="/@"], a[href^="/channel/"]');
    for (const a of links) {
      key = keyFromHref(a.getAttribute('href'));
      if (key) break;
    }
    if (!key) key = pageChannelKey();   // channel-page grids carry no byline

    let videoId = null, isShort = false;
    const v = card.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]');
    if (v) {
      const href = v.getAttribute('href') || '';
      const m = href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
      const sh = href.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
      if (m) videoId = m[1];
      else if (sh) { videoId = sh[1]; isShort = true; }
    }

    const info = { key: key, videoId: videoId, isShort: isShort };
    if (key && videoId) cardCache.set(card, info);
    return info;
  }

  /* Queue a card's channel for scoring. One video per channel is enough for a
     provisional verdict - "Scan channel" deepens it on demand. */
  async function enqueue(info) {
    if (!info.key || !info.videoId) return;
    if (pending.has(info.key) || failed.has(info.key)) return;
    const s = await settings();
    if (!s.scanFeed) return;
    // Shorts ratios aren't comparable to long-form, so they would flag everything.
    if (info.isShort && !s.scanShorts) return;
    if (scansThisSession >= s.maxFeedScans) return;
    const known = await STS.store.getChannel(info.key);
    if (known && known.n) return;      // already have a verdict for this channel
    pending.add(info.key);
    queue.push(info);
    runWorker();
  }

  async function runWorker() {
    if (workerRunning) return;
    workerRunning = true;
    try {
      const s = await settings();
      while (queue.length) {
        const job = queue.shift();
        if (scansThisSession >= s.maxFeedScans) { pending.delete(job.key); continue; }
        scansThisSession++;
        try {
          await scoreVideo(job.videoId, false, { isShort: job.isShort });
        } catch (e) {
          failed.add(job.key);
        }
        pending.delete(job.key);
        scheduleDecorate();
        await sleep(s.scanDelayMs);
      }
    } finally {
      workerRunning = false;
    }
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      enqueue(cardInfo(e.target));
    }
    scheduleDecorate();
  }, { rootMargin: '400px 0px' });

  function observeCards() {
    const cards = document.querySelectorAll(CARD_SEL);
    for (const card of cards) {
      if (observed.has(card)) continue;
      observed.add(card);
      io.observe(card);
    }
    return cards;
  }

  /* ------------------------------------------------------------ highlighting */

  let decorateTimer = null;
  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorate, 300);
  }

  function tipFor(rec, verdict) {
    const bits = ['Stop The Slop: ' + LABEL[verdict] +
                  (Number.isFinite(rec.score) ? ' ' + rec.score : '')];
    if (rec.name) bits.push(rec.name);
    if (rec.manual) bits.push('marked ' + rec.manual + ' by you');
    else if (rec.n) bits.push(rec.n + (rec.n === 1 ? ' video sampled' : ' videos sampled'));
    return bits.join(' - ');
  }

  function paintCard(card, lookup, s) {
    const info = cardInfo(card);
    const rec = lookup(info.key);
    const verdict = rec ? STS.store.effective(rec) : 'unknown';
    const existing = card.querySelector('.sts-thumb-badge');

    if (!rec || verdict === 'ok' || verdict === 'unknown') {
      if (existing) existing.remove();
      card.classList.remove('sts-dim');
      return;
    }
    card.classList.toggle('sts-dim', !!s.dimThumbnails && verdict === 'slop');
    const text = LABEL[verdict] + (Number.isFinite(rec.score) ? ' ' + rec.score : '');
    if (existing) {
      existing.textContent = text;
      existing.className = 'sts-thumb-badge sts-' + verdict;
      existing.title = tipFor(rec, verdict);
      return;
    }
    const b = document.createElement('div');
    b.className = 'sts-thumb-badge sts-' + verdict;
    b.textContent = text;
    b.title = tipFor(rec, verdict);
    const host = card.querySelector(
      'ytd-thumbnail, #thumbnail, .yt-lockup-view-model__content-image') || card;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(b);
  }

  /* Shinigami Eyes style: paint every link pointing at a flagged channel, wherever
     it shows up - bylines, sidebar, descriptions, comment authors. */
  function paintLinks(lookup) {
    const links = document.querySelectorAll('a[href^="/@"], a[href^="/channel/"]');
    for (const a of links) {
      const rec = lookup(keyFromHref(a.getAttribute('href')));
      const verdict = rec ? STS.store.effective(rec) : 'unknown';
      const want = (verdict === 'slop' || verdict === 'suspect') ? 'sts-link-' + verdict : null;
      const had = a.classList.contains('sts-link-slop') ? 'sts-link-slop'
                : a.classList.contains('sts-link-suspect') ? 'sts-link-suspect' : null;
      if (want === had) continue;
      a.classList.remove('sts-link-slop', 'sts-link-suspect');
      if (want) {
        if (a.dataset.stsTitle == null) a.dataset.stsTitle = a.getAttribute('title') || '';
        a.classList.add(want);
        a.title = tipFor(rec, verdict);
      } else if (a.dataset.stsTitle != null) {
        if (a.dataset.stsTitle) a.title = a.dataset.stsTitle;
        else a.removeAttribute('title');
        delete a.dataset.stsTitle;
      }
    }
  }

  async function decorate() {
    const s = await settings();
    const cards = observeCards();
    const map = await STS.store.channels();
    const handles = await new Promise((res) =>
      chrome.storage.local.get('handles', (o) => res(o.handles || {})));

    const lookup = (key) => {
      if (!key) return null;
      const id = /^UC[\w-]{22}$/.test(key) ? key : handles[key];
      return id ? (map[id] || null) : null;
    };

    for (const card of cards) paintCard(card, lookup, s);
    if (s.highlightLinks) paintLinks(lookup);
  }

  /* ------------------------------------------------- channel page + routing */

  async function handleChannelPage() {
    const key = pageChannelKey();
    if (!key) return;
    const rec = await STS.store.getChannel(key);
    const old = document.getElementById('sts-channel-badge');
    if (old) old.remove();
    if (!rec) return;
    const verdict = STS.store.effective(rec);
    if (verdict === 'unknown') return;

    const host = document.querySelector('yt-page-header-view-model .page-header-view-model-wiz__page-header-headline-info') ||
                 document.querySelector('#channel-header-container') ||
                 document.querySelector('#inner-header-container');
    if (!host) return;
    const el = document.createElement('div');
    el.id = 'sts-channel-badge';
    el.className = 'sts-badge sts-' + verdict;
    el.textContent = LABEL[verdict] + (Number.isFinite(rec.score) ? ' ' + rec.score : '') +
                     (rec.n ? ' · ' + rec.n + ' videos' : '');
    host.appendChild(el);
  }

  function route() {
    const path = location.pathname;
    if (path === '/watch' || path.startsWith('/shorts/')) handleWatch();
    else if (path.startsWith('/@') || path.startsWith('/channel/')) handleChannelPage();
    scheduleDecorate();
  }

  /* -------------------------------------------------------- popup messaging */

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'sts-status') {
      (async () => {
        const id = videoIdFromUrl();
        let rec = state.current;
        if (id && (!rec || rec.videoId !== id)) {
          try { rec = await scoreVideo(id, false); } catch (_) { rec = null; }
        }
        let key = null;
        if (rec && rec.channelId) key = rec.channelId;
        else {
          const m = location.pathname.match(/^\/(@[\w.\-]+)/) ||
                    location.pathname.match(/^\/channel\/(UC[\w-]{22})/);
          if (m) key = m[1].startsWith('@') ? m[1].toLowerCase() : m[1];
        }
        const ch = key ? await STS.store.getChannel(key) : null;
        reply({
          ok: true,
          onVideo: !!rec,
          video: rec,
          channel: ch,
          channelKey: key,
          scanned: scansThisSession,
          queued: queue.length,
          url: location.href
        });
      })();
      return true;
    }
    if (msg.type === 'sts-scan') {
      (async () => {
        try {
          const ch = await scanChannel(msg.key);
          route();
          reply({ ok: true, channel: ch });
        } catch (e) {
          reply({ ok: false, error: String(e && e.message || e) });
        }
      })();
      return true;
    }
    if (msg.type === 'sts-mark') {
      (async () => {
        await STS.store.setManual(msg.key, msg.value);
        route();
        reply({ ok: true });
      })();
      return true;
    }
    if (msg.type === 'sts-rescore') {
      (async () => {
        try {
          const id = videoIdFromUrl();
          if (id) await scoreVideo(id, true);
          route();
          reply({ ok: true });
        } catch (e) { reply({ ok: false, error: String(e) }); }
      })();
      return true;
    }
  });

  /* ------------------------------------------------------------------ boot */

  document.addEventListener('yt-navigate-finish', route);
  window.addEventListener('yt-page-data-updated', route);

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; route(); }
  }, 800);

  const mo = new MutationObserver(() => scheduleDecorate());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  route();
})(globalThis.STS);
