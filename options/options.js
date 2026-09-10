/* Stop The Slop - options. */
(function (STS) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SLIDERS = ['slopAt', 'suspectAt', 'minViews', 'deficitClean', 'deficitSlop',
                   'baseRatio', 'disabledScore', 'commentSample', 'topicGuard',
                   'scanDepth', 'maxFeedScans', 'scanDelayMs'];
  const CHECKS = ['autoScan', 'dimThumbnails', 'scanFeed', 'highlightLinks',
                  'scanShorts', 'autoUpdateCheck'];

  // baseRatio is stored as a fraction but edited as "comments per 10,000 views".
  const toPer10k = (frac) => Math.round(frac * 10000);
  const fromPer10k = (n) => n / 10000;

  function label(id, raw) {
    const n = Number(raw);
    switch (id) {
      case 'minViews': return n === 0 ? 'no minimum' : STS.score.fmt(n) + ' views';
      case 'deficitClean':
      case 'deficitSlop': return n + 'x below expected';
      case 'baseRatio': return n + ' per 10k  (' + (n / 100).toFixed(2) + '%)';
      case 'topicGuard': return n + '% weight';
      case 'commentSample': return n + ' comments';
      case 'scanDepth': return n + ' videos';
      case 'maxFeedScans': return n + ' channels';
      case 'scanDelayMs': return (n / 1000).toFixed(2).replace(/0$/, '') + 's';
      default: return String(n);
    }
  }

  function paint(id) {
    const out = $('o-' + id);
    if (out) out.textContent = label(id, $(id).value);
  }

  async function load() {
    const s = await STS.store.settings();
    for (const id of SLIDERS) {
      let v = s[id];
      if (id === 'baseRatio') v = toPer10k(v);
      if (id === 'topicGuard') v = Math.round(v * 100);
      $(id).value = v;
      paint(id);
    }
    for (const id of CHECKS) $(id).checked = !!s[id];
    $('extraStrong').value = (s.extraStrong || []).join('\n');
  }

  async function save() {
    const patch = {};
    for (const id of SLIDERS) {
      let v = Number($(id).value);
      if (id === 'baseRatio') v = fromPer10k(v);
      if (id === 'topicGuard') v = v / 100;
      patch[id] = v;
    }
    for (const id of CHECKS) patch[id] = $(id).checked;
    patch.extraStrong = $('extraStrong').value.split('\n')
      .map((s) => s.trim()).filter(Boolean);

    // Keep the bands sane no matter which slider moved.
    if (patch.suspectAt >= patch.slopAt) patch.suspectAt = Math.max(0, patch.slopAt - 5);
    if (patch.deficitSlop <= patch.deficitClean) patch.deficitSlop = patch.deficitClean * 4;

    await STS.store.setSettings(patch);
    await load();
    const s = $('saved');
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 1400);
  }

  for (const id of SLIDERS) $(id).addEventListener('input', () => paint(id));
  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', async () => {
    await STS.store.setSettings(STS.score.DEFAULTS);
    await load();
  });

  load();
})(globalThis.STS);
