/**
 * URL matching, stored state, and rule resolution.
 *
 * One mechanism: an ordered list of user-defined rules. The first enabled rule whose
 * pattern matches the URL paints the page. Nothing is inferred from the URL beyond
 * what the rules say.
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'colorCodedClients';
  const SCHEMA_VERSION = 3;

  const MATCH_MODES = ['contains', 'wildcard', 'regex'];
  const DEFAULT_MODE = 'contains';

  const LABEL_POSITIONS = [
    'top-left', 'top-center', 'top-right',
    'bottom-left', 'bottom-center', 'bottom-right'
  ];
  const LABEL_SIZE_RANGE = { min: 9, max: 48 };
  const FRAME_WIDTH_RANGE = { min: 1, max: 15 };

  const DEFAULT_SETTINGS = {
    enabled: true,
    frameWidth: 6,
    showLabel: true,
    labelPosition: 'top-right',
    labelSize: 12,
    showFavicon: true,
    showTitlePrefix: true,
    showBadge: true,
    useTabGroups: false
  };

  /** Distance from the label to the side of the viewport it is not pinned to. */
  const LABEL_INSET = 18;

  /**
   * Explicit edge offsets for one of the six positions.
   *
   * This is deliberately JavaScript rather than `[data-position]` CSS rules: every
   * property is reset on every call, so switching from top-right to bottom-left cannot
   * leave a stale `top` or `right` behind, and the page and the options preview share
   * one implementation instead of two that drift.
   *
   * @param {number} gap - the frame width, so the label clears the frame.
   */
  function labelPlacement(position, gap) {
    const parts = LABEL_POSITIONS.includes(position)
      ? position.split('-')
      : DEFAULT_SETTINGS.labelPosition.split('-');
    const vertical = parts[0];
    const horizontal = parts[1];

    const placement = {
      top: 'auto',
      bottom: 'auto',
      left: 'auto',
      right: 'auto',
      transform: 'none',
      borderRadius: vertical === 'top' ? '0 0 6px 6px' : '6px 6px 0 0'
    };
    placement[vertical] = gap + 'px';
    if (horizontal === 'center') {
      placement.left = '50%';
      placement.transform = 'translateX(-50%)';
    } else {
      placement[horizontal] = (gap + LABEL_INSET) + 'px';
    }
    return placement;
  }

  function applyPlacement(node, position, gap) {
    const placement = labelPlacement(position, gap);
    for (const [property, value] of Object.entries(placement)) {
      node.style[property] = value;
    }
  }

  function clampToRange(value, range, fallback) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(range.max, Math.max(range.min, parsed));
  }

  function clampLabelSize(value) {
    return clampToRange(value, LABEL_SIZE_RANGE, DEFAULT_SETTINGS.labelSize);
  }

  function clampFrameWidth(value) {
    return clampToRange(value, FRAME_WIDTH_RANGE, DEFAULT_SETTINGS.frameWidth);
  }

  /* --------------------------------------------------------------- URL matching */

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Separates alternatives within one pattern: `*a.com*||*b.com*`. */
  const ALTERNATION = '||';

  function splitAlternatives(pattern) {
    return pattern.split(ALTERNATION).map(function (part) { return part.trim(); }).filter(Boolean);
  }

  /**
   * @returns {RegExp | null} null when a user's regex does not compile.
   *
   * `contains` and `wildcard` accept `||` between alternatives so one rule can cover
   * several sites without duplicating its label and color. `regex` has `|` already.
   */
  function compilePattern(pattern, mode) {
    if (!pattern) return null;
    try {
      if (mode === 'regex') return new RegExp(pattern, 'i');

      const alternatives = splitAlternatives(pattern);
      if (!alternatives.length) return null;

      if (mode === 'wildcard') {
        const body = alternatives
          .map(function (alt) { return alt.split('*').map(escapeRegExp).join('.*'); })
          .join('|');
        // Anchored, so each alternative must cover the whole URL.
        return new RegExp('^(?:' + body + ')$', 'i');
      }
      return new RegExp(alternatives.map(escapeRegExp).join('|'), 'i');
    } catch (error) {
      return null;
    }
  }

  // Resolution runs on every re-render of the page, so compiled patterns are kept.
  const patternCache = new Map();

  function compileCached(pattern, mode) {
    const cacheKey = mode + ':' + pattern;
    if (!patternCache.has(cacheKey)) patternCache.set(cacheKey, compilePattern(pattern, mode));
    return patternCache.get(cacheKey);
  }

  function ruleMatches(rule, urlString) {
    const expression = compileCached(rule.pattern, rule.mode);
    return Boolean(expression && expression.test(urlString));
  }

  /** Whether a pattern is usable, for inline validation in the editors. */
  function isValidPattern(pattern, mode) {
    return compilePattern(pattern, mode) !== null;
  }

  /**
   * Pre-fills the pattern when adding a rule from the current tab: the host plus the
   * first path segment, which is usually what identifies one system from another.
   */
  function suggestPattern(urlString) {
    let url;
    try {
      url = new URL(urlString);
    } catch (error) {
      return '';
    }
    const firstSegment = url.pathname.split('/').filter(Boolean)[0];
    return url.hostname + (firstSegment ? '/' + decodeURIComponent(firstSegment) : '');
  }

  /* ---------------------------------------------------------------- persistence */

  function newId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Up to three characters fit legibly in a 16px favicon. */
  const MAX_INITIALS = 3;

  /**
   * Derived from the label when the rule does not set its own. Dots split words, because
   * the add-rule form pre-fills the label with a hostname: core.leabank.no gives CL.
   */
  function deriveInitials(label) {
    const letters = String(label)
      .split(/[\s\-_/.]+/)
      .map(function (word) { return word.replace(/[^0-9a-z]/gi, '').charAt(0); })
      .filter(Boolean);
    if (letters.length >= 2) return (letters[0] + letters[1]).toUpperCase();
    const fallback = String(label).replace(/[^0-9a-z]/gi, '').slice(0, 2);
    return (fallback || '?').toUpperCase();
  }

  function normalizeRule(rule) {
    if (!rule || typeof rule !== 'object') return null;
    const pattern = String(rule.pattern || '').trim();
    if (!pattern) return null;
    const mode = MATCH_MODES.includes(rule.mode) ? rule.mode : DEFAULT_MODE;
    return {
      id: rule.id || newId(),
      pattern,
      mode,
      label: String(rule.label || pattern),
      // Stored concretely rather than derived at read time, so the favicon letters are
      // independent of the label: renaming a rule never silently changes its letters.
      // Clearing the field re-seeds them from the label once, as a reset.
      initials: String(rule.initials || '').trim().slice(0, MAX_INITIALS) ||
        deriveInitials(rule.label || pattern),
      color: root.CCCPalette.normalizeHex(rule.color) || root.CCCPalette.colorForKey(pattern),
      enabled: rule.enabled !== false,
      emphasize: Boolean(rule.emphasize)
    };
  }

  function normalizeState(raw) {
    const state = raw || {};
    // Schemas 1 and 2 carried auto-detected Business Central environments alongside the
    // rules. That layer is gone; only the rule list survives.
    const rules = Array.isArray(state.rules) ? state.rules.map(normalizeRule).filter(Boolean) : [];

    // Copy only keys we still recognise. Merging would otherwise carry dead settings
    // from removed features forever, eating the 8KB item quota and making the stored
    // state unreadable when something needs diagnosing.
    const merged = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
    const settings = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) settings[key] = merged[key];

    if (!LABEL_POSITIONS.includes(settings.labelPosition)) {
      settings.labelPosition = DEFAULT_SETTINGS.labelPosition;
    }
    settings.labelSize = clampLabelSize(settings.labelSize);
    settings.frameWidth = clampFrameWidth(settings.frameWidth);
    return { version: SCHEMA_VERSION, settings, rules };
  }

  async function loadState() {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    return normalizeState(stored[STORAGE_KEY]);
  }

  /**
   * chrome.storage.sync rejects on its quotas: 8KB for this single item, 120 writes a
   * minute, 1800 an hour. Those rejections are otherwise invisible in an async event
   * handler, which turns a failed write into "the setting silently did nothing".
   */
  async function saveState(state) {
    try {
      await chrome.storage.sync.set({ [STORAGE_KEY]: state });
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      throw new Error('Could not save: ' + detail);
    }
  }

  async function updateSettings(patch) {
    const state = await loadState();
    state.settings = Object.assign({}, state.settings, patch);
    await saveState(state);
    return state;
  }

  async function addRule(partial) {
    const state = await loadState();
    const rule = normalizeRule(Object.assign({ id: newId() }, partial));
    if (!rule) return state;
    state.rules.push(rule);
    await saveState(state);
    return state;
  }

  async function updateRule(id, patch) {
    const state = await loadState();
    const index = state.rules.findIndex((rule) => rule.id === id);
    if (index === -1) return state;
    const merged = normalizeRule(Object.assign({}, state.rules[index], patch));
    if (merged) state.rules[index] = merged;
    await saveState(state);
    return state;
  }

  async function deleteRule(id) {
    const state = await loadState();
    state.rules = state.rules.filter((rule) => rule.id !== id);
    await saveState(state);
    return state;
  }

  /** Reorder matters: the first matching rule is the one that paints. */
  async function moveRule(id, delta) {
    const state = await loadState();
    const from = state.rules.findIndex((rule) => rule.id === id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= state.rules.length) return state;
    const [moved] = state.rules.splice(from, 1);
    state.rules.splice(to, 0, moved);
    await saveState(state);
    return state;
  }

  /* ----------------------------------------------------------------- resolution */

  /**
   * Every rule matching a URL, in list order.
   * @param {boolean} includeDisabled - the popup needs these, to offer switching a
   *   matching-but-disabled rule back on rather than adding a duplicate.
   */
  function matchingRules(state, urlString, includeDisabled) {
    if (!urlString) return [];
    return state.rules.filter(function (rule) {
      if (!includeDisabled && rule.enabled === false) return false;
      return ruleMatches(rule, urlString);
    });
  }

  function decorate(rule, settings) {
    const color = root.CCCPalette.normalizeHex(rule.color) || '#777777';
    const label = rule.label || rule.pattern;
    return {
      key: rule.id,
      label,
      initials: rule.initials || deriveInitials(label),
      pattern: rule.pattern,
      mode: rule.mode,
      color,
      textColor: root.CCCPalette.readableTextOn(color),
      frameWidth: rule.emphasize ? settings.frameWidth * 2 : settings.frameWidth,
      emphasize: Boolean(rule.emphasize),
      enabled: rule.enabled !== false,
      // Resolution still succeeds when coloring is globally off, so the popup can
      // offer the switch that turns it back on.
      active: settings.enabled !== false
    };
  }

  /**
   * @returns {{key, label, pattern, mode, color, textColor, frameWidth, active} | null}
   */
  function resolveUrl(state, urlString) {
    const [first] = matchingRules(state, urlString, false);
    return first ? decorate(first, state.settings) : null;
  }

  root.CCCRules = {
    STORAGE_KEY,
    SCHEMA_VERSION,
    MATCH_MODES,
    DEFAULT_MODE,
    DEFAULT_SETTINGS,
    LABEL_POSITIONS,
    LABEL_SIZE_RANGE,
    FRAME_WIDTH_RANGE,
    clampFrameWidth,
    ALTERNATION,
    MAX_INITIALS,
    LABEL_INSET,
    labelPlacement,
    applyPlacement,
    clampLabelSize,
    deriveInitials,
    splitAlternatives,
    compilePattern,
    isValidPattern,
    ruleMatches,
    matchingRules,
    suggestPattern,
    normalizeState,
    normalizeRule,
    newId,
    loadState,
    saveState,
    updateSettings,
    addRule,
    updateRule,
    deleteRule,
    moveRule,
    resolveUrl
  };
})(globalThis);
