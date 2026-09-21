/**
 * Options page: the URL rule list, a URL tester, the on-page label controls with a
 * live preview, global signals, and JSON export/import for sharing a scheme.
 */
(function () {
  'use strict';

  const {
    loadState, saveState, updateSettings, addRule, updateRule, deleteRule, moveRule,
    resolveUrl, compilePattern, normalizeRule, clampLabelSize, deriveInitials, applyPlacement,
    MATCH_MODES, DEFAULT_MODE, DEFAULT_SETTINGS, LABEL_POSITIONS, MAX_INITIALS
  } = globalThis.CCCRules;
  const { normalizeHex, colorForKey } = globalThis.CCCPalette;

  const BOOLEAN_SETTINGS = [
    'enabled', 'showLabel', 'showFavicon', 'showTitlePrefix', 'showBadge', 'useTabGroups'
  ];

  const MODE_LABELS = {
    contains: 'URL contains',
    wildcard: 'Wildcard (*)',
    regex: 'Regular expression'
  };

  const POSITION_LABELS = {
    'top-left': 'Top left',
    'top-center': 'Top centre',
    'top-right': 'Top right',
    'bottom-left': 'Bottom left',
    'bottom-center': 'Bottom centre',
    'bottom-right': 'Bottom right'
  };

  const status = document.getElementById('status');
  const rulesBody = document.getElementById('rulesBody');
  const rulesEmpty = document.getElementById('rulesEmpty');
  const transfer = document.getElementById('transfer');
  const testUrl = document.getElementById('testUrl');
  const testResult = document.getElementById('testResult');
  const labelPosition = document.getElementById('labelPosition');
  const labelSize = document.getElementById('labelSize');
  const previewLabel = document.getElementById('previewLabel');

  let latestState = null;
  let flashTimer = null;

  function flash(message) {
    status.textContent = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { status.textContent = ''; }, 2000);
  }

  function element(tag, props, children) {
    const node = Object.assign(document.createElement(tag), props || {});
    for (const child of children || []) node.append(child);
    return node;
  }

  function cell(child, className) {
    const td = element('td', className ? { className } : {});
    if (child) td.append(child);
    return td;
  }

  function debounce(fn, delay) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, delay);
    };
  }

  /* ---------------------------------------------------------------- label setup */

  for (const position of LABEL_POSITIONS) {
    labelPosition.append(element('option', {
      value: position, textContent: POSITION_LABELS[position]
    }));
  }

  /**
   * Real pixel size and the same placement function the page uses, so an oversized or
   * badly placed label looks that way here before it lands on a customer's system.
   */
  function paintPreview() {
    // Gap 0: the preview frame is drawn as a border, not overlaid like the real one.
    applyPlacement(previewLabel, labelPosition.value, 0);
    previewLabel.style.fontSize = labelSize.value + 'px';
    const firstRule = latestState && latestState.rules.find(function (rule) {
      return rule.enabled !== false;
    });
    if (firstRule) {
      previewLabel.textContent = firstRule.label;
      previewLabel.style.background = firstRule.color;
      previewLabel.style.color = globalThis.CCCPalette.readableTextOn(firstRule.color);
      document.getElementById('previewFrame').style.borderColor = firstRule.color;
    }
  }

  const saveLabelSize = debounce(async function () {
    await updateSettings({ labelSize: clampLabelSize(labelSize.value) });
    flash('Saved');
  }, 250);

  labelPosition.onchange = async function () {
    paintPreview();
    await updateSettings({ labelPosition: labelPosition.value });
    flash('Saved');
  };
  labelSize.oninput = function () { paintPreview(); saveLabelSize(); };

  /* ------------------------------------------------------------------ settings */

  function renderSettings(settings) {
    for (const name of BOOLEAN_SETTINGS) {
      const input = document.getElementById(name);
      input.checked = Boolean(settings[name]);
      input.onchange = async function () {
        await updateSettings({ [name]: input.checked });
        flash('Saved');
      };
    }

    labelPosition.value = settings.labelPosition;
    labelSize.value = String(settings.labelSize);

    const width = document.getElementById('frameWidth');
    width.value = String(settings.frameWidth);
    width.onchange = async function () {
      const parsed = parseInt(width.value, 10);
      const clamped = Number.isFinite(parsed)
        ? Math.min(40, Math.max(1, parsed))
        : DEFAULT_SETTINGS.frameWidth;
      width.value = String(clamped);
      await updateSettings({ frameWidth: clamped });
      flash('Saved');
    };
  }

  /* --------------------------------------------------------------- rule editor */

  function renderRules(rules) {
    rulesBody.replaceChildren();
    rulesEmpty.hidden = rules.length > 0;

    rules.forEach(function (rule, index) {
      const row = element('tr');

      const color = element('input', { type: 'color', value: normalizeHex(rule.color) || '#777777' });
      color.onchange = function () { save({ color: normalizeHex(color.value) }); };

      const mode = element('select');
      for (const value of MATCH_MODES) {
        mode.append(element('option', { value, textContent: MODE_LABELS[value] }));
      }
      mode.value = rule.mode;
      mode.onchange = function () { validate(); save({ mode: mode.value }); };

      const pattern = element('input', { type: 'text', value: rule.pattern, spellcheck: false });
      pattern.oninput = validate;
      pattern.onchange = function () {
        if (!pattern.value.trim()) {
          pattern.value = rule.pattern;
          return;
        }
        save({ pattern: pattern.value.trim() });
      };

      const label = element('input', { type: 'text', value: rule.label });
      label.onchange = function () {
        initials.placeholder = deriveInitials(label.value.trim() || rule.pattern);
        save({ label: label.value.trim() || rule.pattern });
      };

      const initials = element('input', {
        type: 'text',
        value: rule.initials || '',
        placeholder: deriveInitials(rule.label),
        maxLength: MAX_INITIALS,
        title: 'Favicon and badge letters. Blank follows the label.'
      });
      initials.onchange = function () { save({ initials: initials.value.trim() }); };

      const emphasize = element('input', { type: 'checkbox', checked: Boolean(rule.emphasize) });
      emphasize.onchange = function () { save({ emphasize: emphasize.checked }); };

      const enabled = element('input', { type: 'checkbox', checked: rule.enabled !== false });
      enabled.onchange = function () { save({ enabled: enabled.checked }); };

      const up = element('button', { className: 'link', textContent: '↑', title: 'Move up' });
      up.disabled = index === 0;
      up.onclick = async function () { await moveRule(rule.id, -1); refresh(); };

      const down = element('button', { className: 'link', textContent: '↓', title: 'Move down' });
      down.disabled = index === rules.length - 1;
      down.onclick = async function () { await moveRule(rule.id, 1); refresh(); };

      const remove = element('button', { className: 'link danger', textContent: 'Remove' });
      remove.onclick = async function () { await deleteRule(rule.id); flash('Removed'); refresh(); };

      function validate() {
        const ok = Boolean(compilePattern(pattern.value.trim(), mode.value));
        row.classList.toggle('rule-invalid', !ok);
        return ok;
      }

      async function save(patch) {
        if (!validate()) return;
        latestState = await updateRule(rule.id, patch);
        flash('Saved');
        paintPreview();
        runTest();
      }

      row.append(
        cell(color), cell(mode), cell(pattern), cell(label), cell(initials),
        cell(emphasize), cell(enabled), cell(null, 'order')
      );
      row.lastChild.append(up, down, remove);
      validate();
      rulesBody.append(row);
    });
  }

  document.getElementById('addRule').onclick = async function () {
    await addRule({
      pattern: 'example.com',
      mode: DEFAULT_MODE,
      label: 'New rule',
      color: colorForKey('example.com' + Date.now())
    });
    refresh();
  };

  /* ---------------------------------------------------------------- URL tester */

  function runTest() {
    const value = testUrl.value.trim();
    if (!value || !latestState) {
      testResult.textContent = '';
      return;
    }
    const resolved = resolveUrl(latestState, value);
    testResult.textContent = resolved
      ? 'Matches "' + resolved.label + '" (' + resolved.pattern + ') — ' + resolved.color
      : 'No rule matches this URL.';
  }

  testUrl.oninput = runTest;

  /* ------------------------------------------------------------ export/import */

  document.getElementById('export').onclick = async function () {
    const state = await loadState();
    transfer.value = JSON.stringify({ rules: state.rules }, null, 2);
    transfer.select();
    flash('Exported — copy the JSON below');
  };

  document.getElementById('import').onclick = async function () {
    let incoming;
    try {
      incoming = JSON.parse(transfer.value);
    } catch (error) {
      flash('That is not valid JSON');
      return;
    }
    const list = Array.isArray(incoming) ? incoming : (incoming && incoming.rules);
    if (!Array.isArray(list)) {
      flash('No rules found in that JSON');
      return;
    }

    const state = await loadState();
    let merged = 0;
    for (const raw of list) {
      const rule = normalizeRule(raw);
      if (!rule) continue;
      // Pattern plus mode is the identity, so re-importing updates rather than duplicates.
      const existing = state.rules.findIndex(function (candidate) {
        return candidate.pattern === rule.pattern && candidate.mode === rule.mode;
      });
      if (existing === -1) state.rules.push(rule);
      else state.rules[existing] = Object.assign({}, rule, { id: state.rules[existing].id });
      merged += 1;
    }

    await saveState(state);
    flash('Imported ' + merged + ' rule' + (merged === 1 ? '' : 's'));
    refresh();
  };

  /* --------------------------------------------------------------------- entry */

  async function refresh() {
    latestState = await loadState();
    renderSettings(latestState.settings);
    renderRules(latestState.rules);
    paintPreview();
    runTest();
  }

  refresh();
})();
