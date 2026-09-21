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

test('a rule can override the favicon letters', () => {
  const state = stateWith([
    { pattern: 'a.com', label: 'Acme Bank', initials: 'ACM', color: '#123456' }
  ]);
  const resolved = resolveUrl(state, 'https://a.com');
  assert.equal(resolved.initials, 'ACM');
  assert.equal(resolved.customInitials, true);
});

test('clearing the letters falls back to the label', () => {
  const state = stateWith([
    { pattern: 'b.com', label: 'Brage Systems', initials: '', color: '#123456' }
  ]);
  const resolved = resolveUrl(state, 'https://b.com');
  assert.equal(resolved.initials, 'BS');
  assert.equal(resolved.customInitials, false);
});

test('letters are trimmed to what fits a 16px favicon', () => {
  assert.equal(normalizeRule({ pattern: 'x', initials: 'TOOLONG' }).initials, 'TOO');
  assert.equal(normalizeRule({ pattern: 'x', initials: '  AB  ' }).initials, 'AB');
  assert.equal(normalizeRule({ pattern: 'x' }).initials, '', 'absent means derive');
  assert.equal(MAX_INITIALS, 3);
});

test('letters survive export and import unchanged', () => {
  const rule = normalizeRule({ pattern: 'a.com', label: 'Acme', initials: 'AC' });
  assert.equal(normalizeRule(JSON.parse(JSON.stringify(rule))).initials, 'AC');
});

/* ------------------------------------------------------------- label appearance */

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
