/**
 * Color palette and color maths.
 *
 * Loaded as a plain script in every context (content script, service worker via
 * importScripts, options page, popup), so it attaches to globalThis rather than
 * using ES module syntax.
 */
(function (root) {
  'use strict';

  /**
   * Sixteen colors chosen to stay distinguishable from each other and to remain
   * readable against the Business Central client's light background.
   */
  const PALETTE = [
    '#D13438', '#CA5010', '#986F0B', '#498205',
    '#0B6A0B', '#038387', '#0078D4', '#004E8C',
    '#8764B8', '#5C2E91', '#C239B3', '#E3008C',
    '#946037', '#00A2AD', '#B146C2', '#5D5A58'
  ];

  /** Chrome's tab group colors, approximated in RGB so we can pick a nearest match. */
  const TAB_GROUP_COLORS = {
    grey: [95, 99, 104],
    blue: [26, 115, 232],
    red: [217, 48, 37],
    yellow: [249, 171, 0],
    green: [30, 142, 62],
    pink: [255, 143, 178],
    purple: [168, 78, 229],
    cyan: [0, 172, 193],
    orange: [250, 144, 59]
  };

  /** FNV-1a. Stable across machines, so the same environment gets the same color everywhere. */
  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /** Deterministic color for a rule key, so new environments are colored without setup. */
  function colorForKey(key) {
    return PALETTE[hashString(key) % PALETTE.length];
  }

  function hexToRgb(hex) {
    const clean = String(hex).replace('#', '').trim();
    const full = clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16)
    ];
  }

  function isValidHex(hex) {
    return hexToRgb(hex) !== null;
  }

  function normalizeHex(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function relativeLuminance(rgb) {
    const channels = rgb.map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  /** Black or white, whichever reads better on the given background. */
  function readableTextOn(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#FFFFFF';
    return relativeLuminance(rgb) > 0.45 ? '#101010' : '#FFFFFF';
  }

  function withAlpha(hex, alpha) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    return 'rgba(' + rgb.join(', ') + ', ' + alpha + ')';
  }

  /** Nearest Chrome tab group color, since that API only accepts nine named values. */
  function nearestTabGroupColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 'grey';
    let best = 'grey';
    let bestDistance = Infinity;
    for (const [name, candidate] of Object.entries(TAB_GROUP_COLORS)) {
      const distance =
        Math.pow(rgb[0] - candidate[0], 2) +
        Math.pow(rgb[1] - candidate[1], 2) +
        Math.pow(rgb[2] - candidate[2], 2);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = name;
      }
    }
    return best;
  }

  root.CCCPalette = {
    PALETTE,
    hashString,
    colorForKey,
    hexToRgb,
    isValidHex,
    normalizeHex,
    readableTextOn,
    withAlpha,
    nearestTabGroupColor
  };
})(globalThis);
