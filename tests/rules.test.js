/**
 * Tests for the pure logic: pattern matching, rule resolution, label settings, and
 * migration off the older schemas. Run with: npm test
 *
 * The libraries are plain scripts that attach to globalThis, so requiring them is
 * enough to install CCCPalette and CCCRules. Nothing here touches chrome.storage.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/lib/palette.js');
require('../src/lib/rules.js');

const {
  resolveUrl, matchingRules, normalizeState, normalizeRule, compilePattern, isValidPattern,
  suggestPattern, clampLabelSize, splitAlternatives, deriveInitials, MAX_INITIALS,
  labelPlacement, applyPlacement, LABEL_INSET, clampFrameWidth, FRAME_WIDTH_RANGE,
  DEFAULT_SETTINGS, LABEL_POSITIONS, LABEL_SIZE_RANGE,
  SCHEMA_VERSION
} = globalThis.CCCRules;
const { PALETTE, colorForKey, normalizeHex, readableTextOn, nearestTabGroupColor } =
  globalThis.CCCPalette;

const BC_URL = 'https://businesscentral.dynamics.com/1a2b3c4d-1111/Production/?company=CRONUS';

function stateWith(rules, settings) {
  return normalizeState({ settings: Object.assign({}, settings), rules });
}

/* ------------------------------------------------------------- pattern matching */

test('contains matches anywhere in the URL, case-insensitively', () => {
  const expression = compilePattern('BUSINESScentral', 'contains');
  assert.ok(expression.test(BC_URL));
  assert.ok(!expression.test('https://example.com'));
});

test('contains treats regex characters literally', () => {
  // A dot in a hostname must not match any character, or one rule leaks onto others.
  assert.ok(!compilePattern('a.c', 'contains').test('https://abc.com'));
  assert.ok(compilePattern('a.c', 'contains').test('https://a.c.com'));
});

test('wildcard is anchored at both ends, which is the easy mistake', () => {
  // The pattern must cover the whole URL, so an unwrapped one silently matches nothing.
  assert.ok(!compilePattern('businesscentral.dynamics.com', 'wildcard').test(BC_URL));
  assert.ok(compilePattern('*businesscentral.dynamics.com*', 'wildcard').test(BC_URL));
  assert.ok(compilePattern('*dynamics*/Production*', 'wildcard').test(BC_URL));
});

test('regex mode compiles user expressions and survives bad ones', () => {
  assert.ok(compilePattern('dynamics\\.com/.+/Prod', 'regex').test(BC_URL));
  assert.equal(compilePattern('([unclosed', 'regex'), null);
  assert.equal(isValidPattern('([unclosed', 'regex'), false);
  assert.equal(isValidPattern('([unclosed', 'contains'), true, 'escaped, so it is literal');
});

test('an empty pattern never compiles', () => {
  assert.equal(compilePattern('', 'contains'), null);
  assert.equal(compilePattern('   '.trim(), 'wildcard'), null);
  assert.equal(compilePattern('||', 'contains'), null, 'separators alone are nothing');
});

test('|| covers several sites in one rule', () => {
  const wildcard = compilePattern('*core.brage.no*||*core.leabank.no*', 'wildcard');
  assert.ok(wildcard.test('https://core.brage.no/loans/42'));
  assert.ok(wildcard.test('https://core.leabank.no/'));
  assert.ok(!wildcard.test('https://core.other.no/'));

  const contains = compilePattern('core.brage.no||core.leabank.no', 'contains');
  assert.ok(contains.test('https://core.brage.no/loans/42'));
  assert.ok(contains.test('https://core.leabank.no/'));
  assert.ok(!contains.test('https://core.other.no/'));
});

test('each || alternative is anchored on its own in wildcard mode', () => {
  // Without per-alternative anchoring, "a" would match any URL containing an "a".
  const expression = compilePattern('*brage.no*||leabank.no', 'wildcard');
  assert.ok(expression.test('https://core.brage.no/x'));
  assert.ok(!expression.test('https://core.leabank.no/x'), 'unwrapped alternative stays anchored');
});

test('|| alternatives are trimmed and regex characters stay literal', () => {
  const expression = compilePattern(' a.com || b.com ', 'contains');
  assert.ok(expression.test('https://a.com'));
  assert.ok(expression.test('https://b.com'));
  assert.ok(!expression.test('https://axcom'), 'the dot is not a wildcard');
});

test('splitAlternatives drops blanks', () => {
  assert.deepEqual(splitAlternatives('a||b'), ['a', 'b']);
  assert.deepEqual(splitAlternatives('a|| ||b'), ['a', 'b']);
  assert.deepEqual(splitAlternatives('  solo  '), ['solo']);
});

test('a || rule resolves like any other', () => {
  const state = stateWith([{
    pattern: '*core.brage.no*||*core.leabank.no*',
    mode: 'wildcard',
    label: 'Norwegian banks',
    color: '#498205'
  }]);
  assert.equal(resolveUrl(state, 'https://core.brage.no/x').label, 'Norwegian banks');
  assert.equal(resolveUrl(state, 'https://core.leabank.no/y').label, 'Norwegian banks');
  assert.equal(resolveUrl(state, 'https://core.other.no/z'), null);
});

/* -------------------------------------------------------------------- resolution */

test('the first enabled matching rule wins, so order is meaningful', () => {
  const state = stateWith([
    { pattern: 'Production', mode: 'contains', label: 'Prod', color: '#AA0000' },
    { pattern: 'businesscentral', mode: 'contains', label: 'Any BC', color: '#0000AA' }
  ]);
  assert.equal(resolveUrl(state, BC_URL).label, 'Prod');
});

test('a disabled rule is skipped so a later rule can take over', () => {
  const state = stateWith([
    { pattern: 'Production', mode: 'contains', label: 'Off', color: '#AA0000', enabled: false },
    { pattern: 'businesscentral', mode: 'contains', label: 'Any BC', color: '#0000AA' }
  ]);
  assert.equal(resolveUrl(state, BC_URL).label, 'Any BC');
});

test('nothing matches without a rule — there is no built-in detection', () => {
  assert.equal(resolveUrl(stateWith([]), BC_URL), null);
  assert.equal(resolveUrl(stateWith([]), 'https://example.com/anything'), null);
});

test('rules work on any site, not just one product', () => {
  const state = stateWith([
    { pattern: 'dev.azure.com/stacc', mode: 'contains', label: 'ADO', color: '#498205' }
  ]);
  assert.equal(
    resolveUrl(state, 'https://dev.azure.com/stacc/Core/_workitems/edit/6736').label, 'ADO'
  );
});

test('matchingRules can surface a disabled rule for the popup to re-enable', () => {
  // Without this the popup would offer to add a second rule for the same URL.
  const state = stateWith([
    { pattern: 'businesscentral', mode: 'contains', label: 'Off', color: '#AA0000', enabled: false }
  ]);
  assert.equal(matchingRules(state, BC_URL, false).length, 0);
  assert.equal(matchingRules(state, BC_URL, true).length, 1);
  assert.equal(matchingRules(state, BC_URL, true)[0].label, 'Off');
});

test('matchingRules tolerates a missing URL', () => {
  assert.deepEqual(matchingRules(stateWith([]), '', true), []);
});

test('frame width doubles only for a bold rule', () => {
  const base = DEFAULT_SETTINGS.frameWidth;
  const bold = stateWith([
    { pattern: 'example.com', mode: 'contains', label: 'x', color: '#123456', emphasize: true }
  ]);
  const plain = stateWith([
    { pattern: 'example.com', mode: 'contains', label: 'x', color: '#123456' }
  ]);
  assert.equal(resolveUrl(bold, 'https://example.com').frameWidth, base * 2);
  assert.equal(resolveUrl(plain, 'https://example.com').frameWidth, base);
});

test('frame width follows the configured setting', () => {
  const state = stateWith(
    [{ pattern: 'example.com', mode: 'contains', label: 'x', color: '#123456' }],
    { frameWidth: 14 }
  );
  assert.equal(resolveUrl(state, 'https://example.com').frameWidth, 14);
});

test('the global off switch deactivates without losing the match', () => {
  const state = stateWith(
    [{ pattern: 'example.com', mode: 'contains', label: 'Acme', color: '#123456' }],
    { enabled: false }
  );
  const resolved = resolveUrl(state, 'https://example.com');
  assert.equal(resolved.active, false);
  assert.equal(resolved.label, 'Acme');
});

test('resolved rules carry what the decorations need', () => {
  const state = stateWith([
    { pattern: '*example.com*', mode: 'wildcard', label: 'Acme', color: '#0B6A0B' }
  ]);
  const resolved = resolveUrl(state, 'https://example.com');
  assert.equal(resolved.color, '#0B6A0B');
  assert.equal(resolved.textColor, '#FFFFFF');
  assert.equal(resolved.mode, 'wildcard');
  assert.equal(resolved.pattern, '*example.com*');
  assert.ok(resolved.key, 'the rule id, for saving edits back');
});

/* ------------------------------------------------------------ state and defaults */

test('older schemas drop their auto-detected environments', () => {
  // Schema 1 keyed BC environments under `rules`; schema 2 moved them to `auto`.
  const fromV1 = normalizeState({
    rules: { 'tenant/production': { label: 'Legacy', color: '#112233' } }
  });
  assert.deepEqual(fromV1.rules, []);
  assert.equal(fromV1.auto, undefined);
  assert.equal(fromV1.version, SCHEMA_VERSION);

  const fromV2 = normalizeState({
    rules: [{ pattern: 'keep.me', mode: 'contains', label: 'Kept', color: '#112233' }],
    auto: { 'tenant/production': { label: 'Legacy', color: '#112233' } }
  });
  assert.equal(fromV2.rules.length, 1, 'real rules survive');
  assert.equal(fromV2.rules[0].label, 'Kept');
  assert.equal(fromV2.auto, undefined);
});

test('settings from removed features are pruned rather than carried forever', () => {
  // Taken from a real stored state: keys left behind by the deleted BC layer.
  const state = normalizeState({
    settings: {
      autoDetectBc: false, autoAssign: false, emphasizeProduction: false,
      showCornerLabel: true, labelPosition: 'top-center', labelSize: 48
    },
    rules: []
  });
  for (const dead of ['autoDetectBc', 'autoAssign', 'emphasizeProduction', 'showCornerLabel']) {
    assert.ok(!(dead in state.settings), dead + ' should be dropped');
  }
  assert.equal(state.settings.labelPosition, 'top-center', 'live settings survive');
  assert.equal(state.settings.labelSize, 48);
  assert.deepEqual(
    Object.keys(state.settings).sort(), Object.keys(DEFAULT_SETTINGS).sort(),
    'exactly the recognised keys, no more and no less'
  );
});

test('normalizeState fills defaults and drops unusable rules', () => {
  const state = normalizeState({ rules: [{ pattern: '' }, null, { pattern: 'ok' }] });
  assert.equal(state.rules.length, 1);
  assert.equal(state.rules[0].pattern, 'ok');
  assert.equal(state.rules[0].mode, 'contains');
  assert.ok(state.rules[0].id, 'every rule gets an id');
  assert.equal(state.settings.frameWidth, DEFAULT_SETTINGS.frameWidth);
});

test('normalizeRule falls back to a derived color and label', () => {
  const rule = normalizeRule({ pattern: 'acme.example' });
  assert.equal(rule.label, 'acme.example');
  assert.ok(PALETTE.includes(rule.color));
  assert.ok(normalizeRule({ pattern: 'x', color: 'not-a-color' }).color.startsWith('#'));
});

test('suggestPattern pre-fills something that matches the tab it came from', () => {
  const bc = suggestPattern(BC_URL);
  assert.equal(bc, 'businesscentral.dynamics.com/1a2b3c4d-1111');
  assert.ok(compilePattern(bc, 'contains').test(BC_URL));

  const ado = suggestPattern('https://dev.azure.com/stacc/Core/_workitems/edit/6736');
  assert.equal(ado, 'dev.azure.com/stacc');
  assert.ok(compilePattern(ado, 'contains').test('https://dev.azure.com/stacc/Core'));

  assert.equal(suggestPattern('https://example.com'), 'example.com');
  assert.equal(suggestPattern('not a url'), '');
});

/* --------------------------------------------------------------- favicon letters */

test('favicon letters derive from the label when the rule sets none', () => {
  assert.equal(deriveInitials('Acme Bank PROD'), 'AB');
  assert.equal(deriveInitials('Brage'), 'BR');
  assert.equal(deriveInitials('core.leabank.no'), 'CL');
  assert.equal(deriveInitials('1'), '1');
  assert.equal(deriveInitials(''), '?', 'never empty, or the favicon is a blank square');
});

test('a rule can set its own favicon letters, including three', () => {
  const state = stateWith([
    { pattern: 'a.com', label: 'Acme Bank', initials: 'ACM', color: '#123456' }
  ]);
  assert.equal(resolveUrl(state, 'https://a.com').initials, 'ACM');
});

test('letters are independent of the label once set', () => {
  // Renaming a rule must not silently change what is drawn in the tab strip.
  const original = normalizeRule({ pattern: 'a.com', label: 'Acme Bank', initials: 'ACM' });
  const renamed = normalizeRule(Object.assign({}, original, { label: 'Totally Different' }));
  assert.equal(renamed.initials, 'ACM');
});

test('clearing the letters re-seeds them from the label, once', () => {
  const seeded = normalizeRule({ pattern: 'b.com', label: 'Brage Systems', initials: '' });
  assert.equal(seeded.initials, 'BS');
  // And having been seeded, they no longer track the label.
  const renamed = normalizeRule(Object.assign({}, seeded, { label: 'Nordic Credit' }));
  assert.equal(renamed.initials, 'BS');
});

test('a new rule is stored with concrete letters rather than deriving them later', () => {
  assert.equal(normalizeRule({ pattern: 'core.leabank.no' }).initials, 'CL');
  assert.equal(normalizeRule({ pattern: 'x', label: 'Acme Bank PROD' }).initials, 'AB');
});

test('letters are trimmed to what fits a 16px favicon', () => {
  assert.equal(normalizeRule({ pattern: 'x', initials: 'TOOLONG' }).initials, 'TOO');
  assert.equal(normalizeRule({ pattern: 'x', initials: '  AB  ' }).initials, 'AB');
  assert.equal(normalizeRule({ pattern: 'x' }).initials, 'X', 'absent is seeded, not left blank');
  assert.equal(MAX_INITIALS, 3);
});

test('letters survive export and import unchanged', () => {
  const rule = normalizeRule({ pattern: 'a.com', label: 'Acme', initials: 'AC' });
  assert.equal(normalizeRule(JSON.parse(JSON.stringify(rule))).initials, 'AC');
});

/* ------------------------------------------------------------- label appearance */

test('each of the six positions pins the right two edges', () => {
  const cases = {
    'top-left': { top: '6px', left: '24px', bottom: 'auto', right: 'auto' },
    'top-right': { top: '6px', right: '24px', bottom: 'auto', left: 'auto' },
    'top-center': { top: '6px', left: '50%', bottom: 'auto', right: 'auto' },
    'bottom-left': { bottom: '6px', left: '24px', top: 'auto', right: 'auto' },
    'bottom-right': { bottom: '6px', right: '24px', top: 'auto', left: 'auto' },
    'bottom-center': { bottom: '6px', left: '50%', top: 'auto', right: 'auto' }
  };
  for (const [position, expected] of Object.entries(cases)) {
    const placement = labelPlacement(position, 6);
    for (const [edge, value] of Object.entries(expected)) {
      assert.equal(placement[edge], value, position + ' ' + edge);
    }
  }
});

test('every edge is reset on every call, so a position change cannot leave a stale one', () => {
  // The bug this guards: switching top-right to bottom-left kept the old top and right.
  for (const position of LABEL_POSITIONS) {
    const placement = labelPlacement(position, 6);
    for (const edge of ['top', 'bottom', 'left', 'right']) {
      assert.ok(edge in placement, position + ' must declare ' + edge);
    }
    const pinned = ['top', 'bottom', 'left', 'right']
      .filter(function (edge) { return placement[edge] !== 'auto'; });
    assert.equal(pinned.length, 2, position + ' pins exactly two edges');
  }
});

test('only the centred positions use a transform', () => {
  assert.equal(labelPlacement('top-center', 0).transform, 'translateX(-50%)');
  assert.equal(labelPlacement('bottom-center', 0).transform, 'translateX(-50%)');
  assert.equal(labelPlacement('top-left', 0).transform, 'none');
  assert.equal(labelPlacement('bottom-right', 0).transform, 'none');
});

test('the label clears the frame and rounds towards the page', () => {
  assert.equal(labelPlacement('top-left', 0).left, LABEL_INSET + 'px');
  assert.equal(labelPlacement('top-left', 12).top, '12px', 'offset by the frame width');
  assert.equal(labelPlacement('top-left', 12).left, (12 + LABEL_INSET) + 'px');
  assert.equal(labelPlacement('top-right', 0).borderRadius, '0 0 6px 6px');
  assert.equal(labelPlacement('bottom-right', 0).borderRadius, '6px 6px 0 0');
});

test('an unknown position places the label rather than leaving it unpositioned', () => {
  const fallback = labelPlacement('middle-nowhere', 6);
  assert.deepEqual(fallback, labelPlacement(DEFAULT_SETTINGS.labelPosition, 6));
});

test('applyPlacement writes every property onto a node', () => {
  const node = { style: {} };
  applyPlacement(node, 'bottom-center', 4);
  assert.equal(node.style.bottom, '4px');
  assert.equal(node.style.top, 'auto');
  assert.equal(node.style.left, '50%');
  assert.equal(node.style.right, 'auto');
  assert.equal(node.style.transform, 'translateX(-50%)');

  // Re-placing the same node must clear what the previous position set.
  applyPlacement(node, 'top-right', 4);
  assert.equal(node.style.top, '4px');
  assert.equal(node.style.bottom, 'auto');
  assert.equal(node.style.left, 'auto');
  assert.equal(node.style.transform, 'none');
});

test('label position falls back when it is not one of the six', () => {
  assert.equal(normalizeState({ settings: { labelPosition: 'middle' } }).settings.labelPosition,
    DEFAULT_SETTINGS.labelPosition);
  for (const position of LABEL_POSITIONS) {
    assert.equal(normalizeState({ settings: { labelPosition: position } }).settings.labelPosition,
      position);
  }
});

test('label size is clamped to a usable range', () => {
  assert.equal(clampLabelSize(1), LABEL_SIZE_RANGE.min);
  assert.equal(clampLabelSize(999), LABEL_SIZE_RANGE.max);
  assert.equal(clampLabelSize('20'), 20);
  assert.equal(clampLabelSize('nonsense'), DEFAULT_SETTINGS.labelSize);
  assert.equal(normalizeState({ settings: { labelSize: 400 } }).settings.labelSize,
    LABEL_SIZE_RANGE.max);
});

test('frame width is clamped to the slider range', () => {
  assert.equal(clampFrameWidth(0), FRAME_WIDTH_RANGE.min);
  assert.equal(clampFrameWidth(999), FRAME_WIDTH_RANGE.max);
  assert.equal(clampFrameWidth('8'), 8);
  assert.equal(clampFrameWidth('nonsense'), DEFAULT_SETTINGS.frameWidth);
  // A width stored by the old free-text field is pulled into range on load.
  assert.equal(normalizeState({ settings: { frameWidth: 40 } }).settings.frameWidth,
    FRAME_WIDTH_RANGE.max);
  assert.deepEqual(FRAME_WIDTH_RANGE, { min: 1, max: 15 });
});

test('a bold rule doubles the clamped width, not the raw one', () => {
  const state = normalizeState({
    settings: { frameWidth: 40 },
    rules: [{ pattern: 'a.com', mode: 'contains', label: 'x', color: '#123456', emphasize: true }]
  });
  assert.equal(resolveUrl(state, 'https://a.com').frameWidth, FRAME_WIDTH_RANGE.max * 2);
});

test('the on-page label is on by default', () => {
  assert.equal(normalizeState({}).settings.showLabel, true);
  assert.equal(normalizeState({ settings: { showLabel: false } }).settings.showLabel, false);
});

/* ----------------------------------------------------------------------- colors */

test('colors are deterministic and come from the palette', () => {
  assert.equal(colorForKey('acme/prod'), colorForKey('acme/prod'));
  assert.ok(PALETTE.includes(colorForKey('acme/prod')));
  assert.notEqual(colorForKey('acme/prod'), colorForKey('acme/sandbox'));
});

test('normalizes and contrasts colors', () => {
  assert.equal(normalizeHex('#abc'), '#AABBCC');
  assert.equal(normalizeHex('zzz'), null);
  assert.equal(readableTextOn('#FFFFFF'), '#101010');
  assert.equal(readableTextOn('#0B6A0B'), '#FFFFFF');
});

test('snaps a hex color to the nearest Chrome tab group color', () => {
  assert.equal(nearestTabGroupColor('#D13438'), 'red');
  assert.equal(nearestTabGroupColor('#0078D4'), 'blue');
  assert.equal(nearestTabGroupColor('nonsense'), 'grey');
});
