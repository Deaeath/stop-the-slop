/* Stop The Slop - service worker. Keeps the toolbar badge in sync with the page verdict. */
importScripts('src/patterns.js', 'src/scoring.js', 'src/store.js');

const COLORS = { slop: '#c22335', suspect: '#d99a1f', ok: '#2f9d5f', unknown: '#666666' };
const TEXT = { slop: 'SLOP', suspect: '!', ok: '', unknown: '' };

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await new Promise((res) => chrome.storage.local.get('settings', res));
  if (!cur.settings) {
    await new Promise((res) => chrome.storage.local.set({ settings: STS.score.DEFAULTS }, res));
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'sts-verdict' || !sender.tab) return;
  const v = msg.verdict || 'unknown';
  const text = v === 'suspect' && Number.isFinite(msg.score) ? String(msg.score) : TEXT[v];
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: text || '' });
  chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: COLORS[v] || COLORS.unknown });
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' });
});
