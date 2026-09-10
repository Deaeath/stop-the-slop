/* Stop The Slop - popup. */
(function (STS) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LABEL = { slop: 'SLOP', suspect: 'SUSPECT', ok: 'CLEAR', unknown: 'UNRATED' };
  let tabId = null;
  let channelKey = null;

  const ask = (msg) => new Promise((res) => {
    if (tabId == null) return res(null);
    chrome.tabs.sendMessage(tabId, msg, (r) => {
      if (chrome.runtime.lastError) return res(null);
      res(r);
    });
  });

  function pill(verdict, score) {
    const s = document.createElement('span');
    s.className = 'pill ' + verdict;
    s.textContent = LABEL[verdict] + (Number.isFinite(score) ? ' ' + score : '');
    return s;
  }

  async function renderCurrent() {
    const card = $('current');
    const status = await ask({ type: 'sts-status' });
    if (!status || !status.ok || (!status.video && !status.channel)) {
      card.classList.add('hidden');
      $('empty').classList.remove('hidden');
      return;
    }
    $('empty').classList.add('hidden');
    card.classList.remove('hidden');
    renderScanStat(status);
    card.textContent = '';

    const ch = status.channel;
    const vid = status.video;
    channelKey = status.channelKey || (vid && vid.channelId) || null;

    const verdict = ch ? STS.store.effective(ch) : (vid ? vid.scored.verdict : 'unknown');
    const score = ch && Number.isFinite(ch.score) ? ch.score : (vid ? vid.scored.total : null);

    const row = document.createElement('div');
    row.className = 'row';
    row.appendChild(pill(verdict, score));
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = (ch && ch.name) || (vid && vid.channelName) || 'This channel';
    row.appendChild(name);
    card.appendChild(row);

    const sub = document.createElement('div');
    sub.className = 'sub';
    if (vid && vid.scored) {
      const sc = vid.scored;
      const bits = [];
      if (Number.isFinite(vid.views)) bits.push(STS.score.fmt(vid.views) + ' views');
      if (vid.commentsDisabled) bits.push('comments off');
      else if (Number.isFinite(vid.commentCount)) bits.push(STS.score.fmt(vid.commentCount) + ' comments');
      if (sc.sampled) bits.push(sc.strong + '/' + sc.sampled + ' comments say AI');
      sub.textContent = bits.join(' · ');
    }
    if (ch && ch.n) {
      sub.textContent += (sub.textContent ? '  |  ' : '') + ch.n + ' videos sampled';
    }
    card.appendChild(sub);

    const ev = (ch && ch.evidence) || (vid && vid.scored && vid.scored.evidence) || [];
    if (ev.length) {
      const q = document.createElement('div');
      q.className = 'quote';
      q.textContent = '“' + ev[0].text.slice(0, 140) + '”';
      card.appendChild(q);
    }

    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.appendChild(btn('Scan channel', async (b) => {
      if (!channelKey) return;
      b.disabled = true;
      b.textContent = 'Scanning…';
      const r = await ask({ type: 'sts-scan', key: channelKey });
      b.textContent = r && r.ok ? 'Done' : 'Failed';
      await renderCurrent();
      await renderList();
    }));
    const marked = ch && ch.manual;
    acts.appendChild(btn(marked === 'slop' ? 'Unmark' : 'Mark slop', async () => {
      await ask({ type: 'sts-mark', key: channelKey, value: marked === 'slop' ? null : 'slop' });
      await renderCurrent(); await renderList();
    }));
    acts.appendChild(btn(marked === 'ok' ? 'Unmark' : 'Mark fine', async () => {
      await ask({ type: 'sts-mark', key: channelKey, value: marked === 'ok' ? null : 'ok' });
      await renderCurrent(); await renderList();
    }));
    card.appendChild(acts);
  }

  function renderScanStat(status) {
    const el = $('scanstat');
    const scanned = status.scanned || 0;
    const queued = status.queued || 0;
    if (!scanned && !queued) { el.textContent = ''; return; }
    el.innerHTML = (queued ? '<span class="dot"></span>' : '') +
      scanned + ' channel' + (scanned === 1 ? '' : 's') + ' scanned on this page' +
      (queued ? ', ' + queued + ' queued' : '');
  }

  function btn(text, fn) {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', () => fn(b));
    return b;
  }

  async function renderList() {
    const map = await STS.store.channels();
    const q = $('filter').value.trim().toLowerCase();
    const rows = Object.values(map)
      .map((r) => ({ r, v: STS.store.effective(r) }))
      .filter((x) => x.v === 'slop' || x.v === 'suspect')
      .filter((x) => !q || String(x.r.name || '').toLowerCase().includes(q))
      .sort((a, b) => (b.r.score || 0) - (a.r.score || 0));

    $('count').textContent = 'Flagged channels (' + rows.length + ')';
    const ul = $('list');
    ul.textContent = '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = q ? 'No match.' : 'Nothing flagged yet.';
      ul.appendChild(li);
      return;
    }
    for (const { r, v } of rows) {
      const li = document.createElement('li');
      li.appendChild(pill(v, r.score));
      const a = document.createElement('a');
      a.textContent = r.name || r.handle || r.id;
      a.href = '#';
      a.title = (r.manual ? 'Marked ' + r.manual + ' by you. ' : '') + (r.n || 0) + ' videos sampled';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'https://www.youtube.com/' + (r.handle || 'channel/' + r.id) });
      });
      li.appendChild(a);
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Forget this channel';
      x.addEventListener('click', async () => { await STS.store.removeChannel(r.id); renderList(); });
      li.appendChild(x);
      ul.appendChild(li);
    }
  }

  $('filter').addEventListener('input', renderList);
  $('opts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  $('export').addEventListener('click', async () => {
    const data = await STS.store.channels();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    chrome.downloads
      ? chrome.downloads.download({ url: URL.createObjectURL(blob), filename: 'stop-the-slop.json' })
      : chrome.tabs.create({ url: URL.createObjectURL(blob) });
  });
  $('clear').addEventListener('click', async () => {
    if (!confirm('Erase every channel verdict Stop The Slop has stored?')) return;
    await STS.store.clearAll();
    renderList();
  });

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const t = tabs && tabs[0];
    if (t && /^https:\/\/www\.youtube\.com\//.test(t.url || '')) tabId = t.id;
    await renderCurrent();
    await renderList();
  });
})(globalThis.STS);
