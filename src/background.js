/**
 * Service worker. Owns the two decorations that live outside the page: the toolbar
 * action (icon, badge, tooltip) and, when enabled, Chrome tab groups.
 */
importScripts('/src/lib/palette.js', '/src/lib/rules.js');

const { loadState, resolveUrl, STORAGE_KEY } = globalThis.CCCRules;
const { nearestTabGroupColor, hexToRgb } = globalThis.CCCPalette;

/* ----------------------------------------------------------------- action icon */

function drawIcon(size, color) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const radius = Math.max(1, Math.round(size * 0.22));
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/** The same letters as the favicon, so the toolbar and the tab strip agree. */
function badgeTextFor(resolved) {
  return (resolved.initials || '').slice(0, 3);
}

async function paintAction(tabId, resolved, settings) {
  if (!resolved) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'Color Coded Clients' });
    return;
  }

  await chrome.action.setIcon({
    tabId,
    imageData: { 16: drawIcon(16, resolved.color), 32: drawIcon(32, resolved.color) }
  });

  const rgb = hexToRgb(resolved.color) || [0, 0, 0];
  await chrome.action.setBadgeBackgroundColor({ tabId, color: [rgb[0], rgb[1], rgb[2], 255] });
  await chrome.action.setBadgeTextColor({ tabId, color: resolved.textColor });
  await chrome.action.setBadgeText({
    tabId,
    text: settings.showBadge ? badgeTextFor(resolved) : ''
  });

  await chrome.action.setTitle({
    tabId,
    title: resolved.label + '\nRule: ' + resolved.pattern
  });
}

/* ------------------------------------------------------------------ tab groups */

async function syncTabGroup(tab, resolved) {
  const title = resolved.label;
  const color = nearestTabGroupColor(resolved.color);

  if (tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
    if (group && group.title === title) {
      if (group.color !== color) await chrome.tabGroups.update(group.id, { color });
      return;
    }
  }

  const existing = await chrome.tabGroups.query({ windowId: tab.windowId, title });
  if (existing.length) {
    await chrome.tabs.group({ tabIds: tab.id, groupId: existing[0].id });
    if (existing[0].color !== color) await chrome.tabGroups.update(existing[0].id, { color });
    return;
  }

  const groupId = await chrome.tabs.group({ tabIds: tab.id });
  await chrome.tabGroups.update(groupId, { title, color });
}

/* --------------------------------------------------------------------- driving */

async function handleTab(tab) {
  if (!tab || !tab.id || !tab.url) return;
  try {
    const state = await loadState();
    const resolved = resolveUrl(state, tab.url);
    await paintAction(tab.id, resolved && resolved.active ? resolved : null, state.settings);

    if (resolved && resolved.active && state.settings.useTabGroups) {
      await syncTabGroup(tab, resolved);
    }
  } catch (error) {
    // A tab closed or navigated mid-update. Nothing here is worth interrupting for.
  }
}

async function refreshAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(handleTab));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  handleTab(tab);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) handleTab(tab);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE_KEY]) refreshAllTabs();
});

chrome.runtime.onInstalled.addListener(refreshAllTabs);
chrome.runtime.onStartup.addListener(refreshAllTabs);
