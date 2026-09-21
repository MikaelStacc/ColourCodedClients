/**
 * Paints the page for the matching rule: a viewport frame, an on-page label, a
 * generated favicon, and a title prefix.
 *
 * Single-page apps rewrite their own title and favicon and re-render large parts of the
 * DOM, so every decoration is re-applied whenever the page changes rather than written
 * once. That is the whole reason this exists rather than an off-the-shelf marker.
 */
(function () {
  'use strict';

  if (globalThis.__cccContentLoaded) return;
  globalThis.__cccContentLoaded = true;

  const { loadState, resolveUrl, applyPlacement, STORAGE_KEY } = globalThis.CCCRules;

  const TITLE_PREFIX_PATTERN = /^\[[^\]]{0,60}\]\s/;
  const XML_ESCAPES = {
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;'
  };

  let state = null;
  let current = null;
  let lastUrl = location.href;
  let lastReport = '';
  const removedIconLinks = [];

  /* ---------------------------------------------------------------- decorations */

  function ensureOverlay(id) {
    const root = document.documentElement;
    if (!root) return null;
    let node = document.getElementById(id);
    if (!node) {
      node = document.createElement('div');
      node.id = id;
    }
    if (node.parentNode !== root) root.appendChild(node);
    return node;
  }

  function applyFrame() {
    const frame = ensureOverlay('ccc-frame');
    if (!frame) return;
    frame.style.setProperty('--ccc-color', current.color);
    frame.style.setProperty('--ccc-width', current.frameWidth + 'px');
  }

  function applyLabel() {
    if (!state.settings.showLabel) {
      const existing = document.getElementById('ccc-label');
      if (existing) existing.remove();
      return;
    }
    const label = ensureOverlay('ccc-label');
    if (!label) return;
    label.style.setProperty('--ccc-color', current.color);
    label.style.setProperty('--ccc-text-color', current.textColor);
    label.style.setProperty('--ccc-label-size', state.settings.labelSize + 'px');
    // Offset by the frame width so the two never overlap, and reset every edge so no
    // stale offset survives a change of position.
    applyPlacement(label, state.settings.labelPosition, current.frameWidth);
    if (label.textContent !== current.label) label.textContent = current.label;
  }

  function escapeXml(value) {
    return value.replace(/[<>&"']/g, function (ch) { return XML_ESCAPES[ch]; });
  }

  /** Font size and baseline per character count, so 1–3 letters all fill the tile. */
  const FAVICON_METRICS = {
    1: { size: 21, baseline: 23.5 },
    2: { size: 17, baseline: 22.5 },
    3: { size: 12.5, baseline: 21 }
  };

  function faviconDataUri() {
    const raw = current.initials || '?';
    const metrics = FAVICON_METRICS[raw.length] || FAVICON_METRICS[3];
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="' + current.color + '"/>' +
      '<text x="16" y="' + metrics.baseline + '" text-anchor="middle"' +
      ' font-family="Segoe UI, Arial, sans-serif" font-size="' + metrics.size + '"' +
      ' font-weight="700" fill="' + current.textColor + '">' + escapeXml(raw) + '</text>' +
      '</svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function applyFavicon() {
    if (!document.head) return;
    if (!state.settings.showFavicon) {
      restoreFavicon();
      return;
    }
    // Take the page's own icons out of the document so ours is unambiguously the one
    // Chrome uses. They are kept so they can be put back when we are switched off.
    document.querySelectorAll('link[rel~="icon"]').forEach(function (link) {
      if (link.id === 'ccc-favicon') return;
      // Capped: if the SPA keeps re-adding its icon we keep removing it, and only the
      // first few need to survive for a restore.
      if (removedIconLinks.length < 8) removedIconLinks.push(link);
      link.remove();
    });

    let link = document.getElementById('ccc-favicon');
    if (!link) {
      link = document.createElement('link');
      link.id = 'ccc-favicon';
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      document.head.appendChild(link);
    }
    const href = faviconDataUri();
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }

  function restoreFavicon() {
    const link = document.getElementById('ccc-favicon');
    if (link) link.remove();
    while (removedIconLinks.length) {
      const original = removedIconLinks.pop();
      if (document.head && !original.isConnected) document.head.appendChild(original);
    }
  }

  function stripTitlePrefix(title) {
    return title.replace(TITLE_PREFIX_PATTERN, '');
  }

  function applyTitle() {
    if (!document.head) return;
    const bare = stripTitlePrefix(document.title);
    const wanted = state.settings.showTitlePrefix ? '[' + current.label + '] ' + bare : bare;
    if (document.title !== wanted) document.title = wanted;
  }

  function clearDecorations() {
    const frame = document.getElementById('ccc-frame');
    if (frame) frame.remove();
    const label = document.getElementById('ccc-label');
    if (label) label.remove();
    restoreFavicon();
    const bare = stripTitlePrefix(document.title);
    if (document.title !== bare) document.title = bare;
  }

  /* -------------------------------------------------------------------- driving */

  /** One line per outcome change, so "never injected" is distinguishable from "no match". */
  function report(message) {
    if (message === lastReport) return;
    lastReport = message;
    console.info('[Color Coded Clients] ' + message);
  }

  function apply() {
    if (!state) return;
    const resolved = resolveUrl(state, location.href);
    if (!resolved || !resolved.active) {
      current = null;
      clearDecorations();
      return;
    }
    // The script runs on every page now, so an unmatched page stays silent. The popup
    // is where you look to find out why something is not colored.
    report('coloring as ' + resolved.label + ' ' + resolved.color);
    current = resolved;
    applyFrame();
    applyLabel();
    applyFavicon();
    applyTitle();
  }

  async function refresh() {
    state = await loadState();
    apply();
  }

  /** Re-apply after the SPA rewrites head or wipes our nodes out of the DOM. */
  function watchDocument() {
    let queued = false;
    const observer = new MutationObserver(function () {
      if (queued || !current) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        apply();
      });
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function watchNavigation() {
    // BC routes with the History API, so there is no load event to hook.
    setInterval(function () {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      apply();
    }, 750);
    addEventListener('popstate', apply);
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync' && changes[STORAGE_KEY]) refresh();
  });

  // The popup asks what this page is actually showing. A tab that was open before the
  // extension loaded has no content script and never answers, which is the difference
  // between "the rule is wrong" and "reload the page".
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== 'ccc-ping') return false;
    sendResponse({
      alive: true,
      applied: Boolean(current),
      label: current ? current.label : '',
      color: current ? current.color : '',
      // Reported separately from the settings so the popup can tell "switched off"
      // apart from "switched on but the element never made it into the page".
      labelShown: Boolean(document.getElementById('ccc-label')),
      showLabel: Boolean(state && state.settings.showLabel),
      labelPosition: state ? state.settings.labelPosition : '',
      labelSize: state ? state.settings.labelSize : 0
    });
    return false;
  });

  refresh();
  watchNavigation();

  // At document_start the root element normally exists, but not on every navigation
  // path, and observing null throws.
  if (document.documentElement) {
    watchDocument();
  } else {
    addEventListener('DOMContentLoaded', watchDocument, { once: true });
  }
})();
