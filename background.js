/* Stop The Slop - service worker.
 * Keeps the toolbar badge in sync with the page verdict, and checks GitHub
 * releases so the extension can tell you when a new version is out. */
importScripts('src/patterns.js', 'src/scoring.js', 'src/store.js');

const REPO = 'Deaeath/stop-the-slop';
const RELEASES_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const CHECK_ALARM = 'sts-update-check';

const COLORS = { slop: '#c22335', suspect: '#d99a1f', ok: '#2f9d5f', unknown: '#666666' };
const TEXT = { slop: 'SLOP', suspect: '!', ok: '', unknown: '' };

const get = (k) => new Promise((r) => chrome.storage.local.get(k, r));
const set = (o) => new Promise((r) => chrome.storage.local.set(o, r));

/* ------------------------------------------------------------ update check */

function parseVersion(v) {
  return String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

/** Is version a strictly newer than version b? */
function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

async function checkForUpdate(manual) {
  const current = chrome.runtime.getManifest().version;
  const store = await get(['settings', 'update']);
  const settings = Object.assign({}, STS.score.DEFAULTS, store.settings || {});
  if (!manual && settings.autoUpdateCheck === false) return null;

  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('GitHub returned ' + res.status);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => /\.zip$/i.test(a.name || ''));
    const info = {
      current: current,
      latest: latest,
      available: isNewer(latest, current),
      releaseUrl: rel.html_url,
      zipUrl: asset ? asset.browser_download_url : rel.html_url,
      publishedAt: rel.published_at,
      checkedAt: Date.now(),
      error: null
    };
    const prev = store.update || {};
    await set({ update: Object.assign({ notifiedFor: prev.notifiedFor || null }, info) });
    await paintUpdateBadge(info);
    if (info.available && prev.notifiedFor !== latest) {
      notifyUpdate(info);
      await set({ update: Object.assign({}, info, { notifiedFor: latest }) });
    }
    return info;
  } catch (e) {
    const info = { current: current, error: String((e && e.message) || e), checkedAt: Date.now() };
    await set({ update: Object.assign({}, store.update || {}, info) });
    return info;
  }
}

async function paintUpdateBadge(info) {
  if (!info || !info.available) return;
  // Global badge - per-tab verdict badges still take priority on YouTube tabs.
  chrome.action.setBadgeText({ text: 'NEW' });
  chrome.action.setBadgeBackgroundColor({ color: '#2f6fd9' });
}

function notifyUpdate(info) {
  if (!chrome.notifications) return;
  chrome.notifications.create('sts-update-' + info.latest, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Stop The Slop v' + info.latest + ' is out',
    message: 'You are on v' + info.current + '. Click to open the release and download the new build.',
    buttons: [{ title: 'Open release' }],
    priority: 1
  });
}

function openRelease() {
  get('update').then((o) => {
    const u = (o.update && (o.update.releaseUrl || o.update.zipUrl)) ||
              'https://github.com/' + REPO + '/releases/latest';
    chrome.tabs.create({ url: u });
  });
}

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    if (String(id).startsWith('sts-update-')) openRelease();
  });
  chrome.notifications.onButtonClicked.addListener((id) => {
    if (String(id).startsWith('sts-update-')) openRelease();
  });
}

/* ------------------------------------------------------------------ wiring */

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await get('settings');
  if (!cur.settings) await set({ settings: STS.score.DEFAULTS });
  chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
  checkForUpdate(false);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
  checkForUpdate(false);
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === CHECK_ALARM) checkForUpdate(false);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'sts-verdict' && sender.tab) {
    const v = msg.verdict || 'unknown';
    const text = v === 'suspect' && Number.isFinite(msg.score) ? String(msg.score) : TEXT[v];
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: text || '' });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: COLORS[v] || COLORS.unknown });
    return;
  }

  if (msg.type === 'sts-check-update') {
    checkForUpdate(true).then((info) => reply({ ok: true, info: info }));
    return true;
  }

  if (msg.type === 'sts-open-release') {
    openRelease();
    return;
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId: tabId, text: '' });
});
