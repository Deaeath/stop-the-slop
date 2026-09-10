/* Stop The Slop - talks to YouTube's own internal API (same-origin, no API key needed).
 * Every reader here is defensive: YouTube reshapes these payloads often, so we walk
 * the JSON looking for shapes instead of hardcoding paths. */
globalThis.STS = globalThis.STS || {};
(function (STS) {
  'use strict';

  const FALLBACK_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // public WEB client key
  let cfgCache = null;

  function walk(node, visit, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 60) return;
    visit(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], visit, depth + 1);
    } else {
      for (const k in node) walk(node[k], visit, depth + 1);
    }
  }

  function textOf(o) {
    if (!o) return '';
    if (typeof o === 'string') return o;
    if (o.simpleText) return o.simpleText;
    if (Array.isArray(o.runs)) return o.runs.map(function (r) { return r.text || ''; }).join('');
    if (o.content) return String(o.content);
    return '';
  }

  /** "1.2K", "1,234", "3.4M views" -> number */
  function parseCount(raw) {
    if (raw == null) return NaN;
    if (typeof raw === 'number') return raw;
    const s = String(raw).replace(/,/g, '').trim();
    const m = s.match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return NaN;
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return NaN;
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') n *= 1e3;
    else if (suf === 'M') n *= 1e6;
    else if (suf === 'B') n *= 1e9;
    return Math.round(n);
  }

  async function cfg() {
    if (cfgCache) return cfgCache;
    let key = FALLBACK_KEY;
    let clientVersion = '2.20240101.00.00';
    try {
      const html = await (await fetch('https://www.youtube.com/', { credentials: 'include' })).text();
      const k = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      const v = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
      if (k) key = k[1];
      if (v) clientVersion = v[1];
    } catch (_) { /* fall back to the constants */ }
    cfgCache = { key, clientVersion };
    return cfgCache;
  }

  async function api(endpoint, body) {
    const c = await cfg();
    const url = 'https://www.youtube.com/youtubei/v1/' + endpoint +
                '?key=' + encodeURIComponent(c.key) + '&prettyPrint=false';
    const payload = Object.assign({
      context: { client: { clientName: 'WEB', clientVersion: c.clientVersion, hl: 'en', gl: 'US' } }
    }, body);
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('innertube ' + endpoint + ' ' + res.status);
    return res.json();
  }

  function tokenOf(cir) {
    return cir && cir.continuationEndpoint &&
           cir.continuationEndpoint.continuationCommand &&
           cir.continuationEndpoint.continuationCommand.token;
  }

  /** Pull the comments-section continuation token out of a /next response. */
  function commentToken(json) {
    let token = null;
    walk(json, function (n) {
      if (token) return;
      const isr = n.itemSectionRenderer;
      if (isr && isr.sectionIdentifier === 'comment-item-section') {
        walk(isr, function (m) {
          const t = tokenOf(m.continuationItemRenderer);
          if (t && !token) token = t;
        });
      }
    });
    if (!token) {
      walk(json, function (n) {
        if (token) return;
        const cir = n.continuationItemRenderer;
        if (cir && /comment/i.test(String(cir.targetId || ''))) {
          const t = tokenOf(cir);
          if (t) token = t;
        }
      });
    }
    return token;
  }

  /** Comment texts from a comments continuation response (new + legacy shapes). */
  function commentTexts(json) {
    const out = [];
    walk(json, function (n) {
      const p = n.commentEntityPayload;
      if (p && p.properties && p.properties.content) {
        const t = textOf(p.properties.content);
        if (t) out.push(t);
        return;
      }
      const cr = n.commentRenderer;
      if (cr && cr.contentText) {
        const t = textOf(cr.contentText);
        if (t) out.push(t);
      }
    });
    return out;
  }

  /** Exact comment count from the comments header ("1,234 Comments"). */
  function commentHeaderCount(json) {
    let count = NaN;
    walk(json, function (n) {
      if (Number.isFinite(count)) return;
      const h = n.commentsHeaderRenderer;
      if (h) {
        const raw = textOf(h.countText) || textOf(h.commentsCount);
        const c = parseCount(raw);
        if (Number.isFinite(c)) count = c;
      }
    });
    return count;
  }

  /** Rounded count from the watch page's comment teaser, plus "comments off" detection. */
  function entryPointCount(json) {
    let count = NaN;
    let disabled = false;
    walk(json, function (n) {
      const h = n.commentsEntryPointHeaderRenderer;
      if (h && !Number.isFinite(count)) {
        const raw = textOf(h.commentCount) || textOf(h.contextualInfo);
        const c = parseCount(raw);
        if (Number.isFinite(c)) count = c;
      }
      const m = n.messageRenderer;
      if (m && /comments are turned off/i.test(textOf(m.text))) disabled = true;
    });
    return { count: count, disabled: disabled };
  }

  function videoMeta(json) {
    let views = NaN, title = '', channelId = null, channelName = '', handle = null, description = '';
    walk(json, function (n) {
      const vc = n.videoViewCountRenderer;
      if (vc && !Number.isFinite(views)) {
        // originalViewCount is a literal "0" placeholder on current payloads,
        // so only take it when it actually holds a number.
        const orig = parseCount(vc.originalViewCount);
        const shown = parseCount(textOf(vc.viewCount));
        const c = Number.isFinite(shown) && shown > 0 ? shown : orig;
        if (Number.isFinite(c) && c > 0) views = c;
      }
      const pi = n.videoPrimaryInfoRenderer;
      if (pi && !title) title = textOf(pi.title);
      const owner = n.videoOwnerRenderer;
      if (owner && !channelId) {
        channelName = textOf(owner.title);
        const run = (owner.title && owner.title.runs && owner.title.runs[0]) || null;
        const be = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
        if (be) {
          channelId = be.browseId || null;
          const hm = String(be.canonicalBaseUrl || '').match(/\/(@[\w.\-]+)/);
          if (hm) handle = hm[1].toLowerCase();
        }
      }
      const si = n.videoSecondaryInfoRenderer;
      if (si && !description) {
        description = textOf(si.attributedDescription) || textOf(si.description);
      }
    });
    return { views: views, title: title, channelId: channelId,
             channelName: channelName, handle: handle, description: description };
  }

  /** Exact metadata from the /player endpoint. The most stable source there is. */
  function playerMeta(json) {
    const d = (json && json.videoDetails) || null;
    const mf = json && json.microformat && json.microformat.playerMicroformatRenderer;
    if (!d) return null;
    const views = parseCount(d.viewCount);
    let handle = null;
    if (mf && mf.ownerProfileUrl) {
      const m = String(mf.ownerProfileUrl).match(/\/(@[\w.\-]+)/);
      if (m) handle = m[1].toLowerCase();
    }
    return {
      views: Number.isFinite(views) ? views : NaN,
      title: d.title || '',
      description: d.shortDescription || '',
      channelId: d.channelId || null,
      channelName: d.author || '',
      handle: handle
    };
  }

  /**
   * Everything Stop The Slop needs about one video: /next for metadata, then
   * comment continuations for the exact count and the comment text itself.
   */
  async function inspectVideo(videoId, sampleSize) {
    const want = Math.max(0, sampleSize == null ? 40 : sampleSize);
    const [playerRes, first] = await Promise.all([
      api('player', { videoId: videoId }).catch(function () { return null; }),
      api('next', { videoId: videoId })
    ]);

    // Watch-page renderers are the fallback; /player is authoritative when present.
    const fallback = videoMeta(first);
    const exact = playerRes ? playerMeta(playerRes) : null;
    const meta = {
      views: exact && Number.isFinite(exact.views) ? exact.views : fallback.views,
      title: (exact && exact.title) || fallback.title,
      description: (exact && exact.description) || fallback.description,
      channelId: (exact && exact.channelId) || fallback.channelId,
      channelName: (exact && exact.channelName) || fallback.channelName,
      handle: (exact && exact.handle) || fallback.handle
    };
    const ep = entryPointCount(first);

    let commentCount = ep.count;
    let commentsDisabled = ep.disabled;
    const comments = [];

    let token = commentToken(first);
    if (!token && !Number.isFinite(commentCount)) commentsDisabled = true;

    let pages = 0;
    while (token && comments.length < want && pages < 6) {
      let page;
      try {
        page = await api('next', { continuation: token });
      } catch (_) { break; }
      pages++;
      if (pages === 1) {
        const exact = commentHeaderCount(page);
        if (Number.isFinite(exact)) commentCount = exact; // authoritative, unrounded
      }
      const texts = commentTexts(page);
      if (!texts.length && pages === 1 && !Number.isFinite(commentCount)) commentsDisabled = true;
      for (const t of texts) {
        if (comments.length < want) comments.push(t);
      }
      let nextToken = null;
      walk(page, function (n) {
        if (nextToken) return;
        const t = tokenOf(n.continuationItemRenderer);
        if (t && t !== token) nextToken = t;
      });
      token = comments.length < want ? nextToken : null;
    }

    return {
      videoId: videoId,
      views: meta.views,
      title: meta.title,
      description: meta.description,
      channelId: meta.channelId,
      channelName: meta.channelName,
      handle: meta.handle,
      commentCount: commentsDisabled ? 0 : commentCount,
      commentsDisabled: commentsDisabled,
      comments: comments
    };
  }

  /** Recent long-form uploads for a channel, read off its /videos tab. */
  async function channelVideos(pathOrId, limit) {
    const n = limit || 6;
    let path;
    if (/^UC[\w-]{22}$/.test(pathOrId)) path = '/channel/' + pathOrId;
    else if (String(pathOrId).charAt(0) === '@') path = '/' + pathOrId;
    else path = String(pathOrId).charAt(0) === '/' ? String(pathOrId) : '/' + pathOrId;

    const res = await fetch('https://www.youtube.com' + path + '/videos', { credentials: 'include' });
    const html = await res.text();

    const ids = [];
    const re = /"videoId":"([A-Za-z0-9_-]{11})"/g;
    let m;
    while ((m = re.exec(html)) !== null && ids.length < n * 3) {
      if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
    }
    const idMatch = html.match(/"externalId":"(UC[\w-]{22})"/) ||
                    html.match(/"channelId":"(UC[\w-]{22})"/);
    const nameMatch = html.match(/<meta property="og:title" content="([^"]*)"/);
    const handleMatch = html.match(/"canonicalBaseUrl":"\/(@[\w.\-]+)"/);

    return {
      channelId: idMatch ? idMatch[1] : null,
      name: nameMatch ? nameMatch[1] : '',
      handle: handleMatch ? handleMatch[1].toLowerCase() : null,
      videoIds: ids.slice(0, n)
    };
  }

  STS.tube = {
    inspectVideo: inspectVideo,
    playerMeta: playerMeta,
    channelVideos: channelVideos,
    parseCount: parseCount,
    textOf: textOf,
    walk: walk
  };
})(globalThis.STS);
