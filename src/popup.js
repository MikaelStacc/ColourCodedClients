/**
 * Popup, in two states:
 *
 *   matched  - the page is already colored. Rename and recolor it here.
 *   no match - offer a rule for this tab, with the pattern pre-filled from the URL and
 *              a live verdict showing whether it matches as you edit it.
 *
 * Both states open with a banner reporting what the page is ACTUALLY showing, obtained
 * by pinging the content script rather than inferred from the rules. A tab opened
 * before the extension loaded has no content script and stays uncolored no matter how
 * correct the rule is, and that is otherwise indistinguishable from a broken pattern.
 */
(function () {
  'use strict';

  const {
    loadState, resolveUrl, matchingRules, suggestPattern, addRule, updateRule,
    compilePattern, splitAlternatives, deriveInitials, updateSettings,
    MATCH_MODES, DEFAULT_MODE, ALTERNATION, MAX_INITIALS
  } = globalThis.CCCRules;
  const { PALETTE, normalizeHex, colorForKey, readableTextOn } = globalThis.CCCPalette;

  const app = document.getElementById('app');

  const MODE_LABELS = {
    contains: 'URL contains',
    wildcard: 'Wildcard (*)',
    regex: 'Regular expression'
  };

  /* ----------------------------------------------------------------- utilities */

  function element(tag, props, children) {
    const node = Object.assign(document.createElement(tag), props || {});
    for (const child of children || []) node.append(child);
    return node;
  }

  function field(labelText, control) {
    const wrap = element('label', { className: 'field' });
    wrap.append(element('span', { textContent: labelText }), control);
    return wrap;
  }

  function debounce(fn, delay) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, delay);
    };
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /** @returns {{alive, applied, label, color, source} | null} null = no content script. */
  async function pingTab(tabId) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'ccc-ping' });
    } catch (error) {
      return null;
    }
  }

  /**
   * Every popup state ends with this. The rule list has to be reachable from the
   * toolbar button no matter what the current tab is — including a chrome:// page that
   * can never be colored, which is otherwise a dead end.
   */
  function footer(leading) {
    const optionsButton = element('button', { className: 'link', textContent: 'All rules' });
    optionsButton.addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
    const row = element('div', { className: 'row' });
    for (const node of leading || []) row.append(node);
    row.append(element('span', { className: 'grow' }), optionsButton);
    return row;
  }

  function banner(kind, text, actionLabel, onAction) {
    const node = element('div', { className: 'banner ' + kind });
    node.append(element('span', { className: 'grow', textContent: text }));
    if (actionLabel) {
      const button = element('button', { className: 'link', textContent: actionLabel });
      button.addEventListener('click', onAction);
      node.append(button);
    }
    return node;
  }

  /**
   * Banners answering "what is this page actually showing right now?", from the content
   * script rather than inferred from the rules. Returns a list: the on-page label can be
   * missing for its own reason while everything else is working.
   */
  function liveBanner(tab, live, resolved) {
    const reload = function () { chrome.tabs.reload(tab.id); window.close(); };

    if (!live) {
      return [banner('warn',
        'This tab was open before the extension loaded, so nothing is applied yet.',
        'Reload page', reload)];
    }

    const banners = [];
    if (live.applied) {
      banners.push(banner('ok', 'Colored on this page as "' + live.label + '".'));
      if (!live.labelShown) {
        banners.push(live.showLabel
          ? banner('bad', 'The on-page label should be showing but is not in the page.',
            'Reload page', reload)
          : banner('warn', 'The on-page label is switched off.',
            'Switch it on', async function () {
              await updateSettings({ showLabel: true });
              await wait(400);
              render();
            }));
      }
    } else if (resolved && !resolved.active) {
      banners.push(banner('warn', 'A rule matches, but coloring is switched off for it.'));
    } else if (resolved) {
      banners.push(banner('bad', 'A rule matches but the page is not painted. Try reloading.',
        'Reload page', reload));
    } else {
      banners.push(banner('warn', 'No rule matches this page yet.'));
    }
    return banners;
  }

  /** Palette grid wired to a color input; returns a repaint function. */
  function buildPalette(colorInput, onPick) {
    const grid = element('div', { className: 'palette' });
    for (const color of PALETTE) {
      const button = element('button', { type: 'button', title: color });
      button.dataset.color = color;
      button.style.background = color;
      button.addEventListener('click', function () {
        colorInput.value = color;
        onPick();
      });
      grid.append(button);
    }
    function repaint() {
      const current = normalizeHex(colorInput.value);
      for (const button of grid.children) {
        button.setAttribute('aria-pressed', String(button.dataset.color === current));
      }
    }
    return { grid, repaint };
  }

  /** `*` around each alternative that lacks one; leaves deliberate patterns alone. */
  function wrapForWildcard(pattern) {
    return splitAlternatives(pattern)
      .map(function (part) { return part.includes('*') ? part : '*' + part + '*'; })
      .join(ALTERNATION);
  }

  /**
   * Wildcard patterns are anchored at both ends, so a pattern written for "contains"
   * stops matching the moment the mode changes. Wrapping it preserves the intent
   * instead of silently breaking the rule.
   */
  function adaptPatternToMode(pattern, mode) {
    const trimmed = pattern.trim();
    if (mode !== 'wildcard' || !trimmed) return trimmed;
    return wrapForWildcard(trimmed);
  }

  /* ------------------------------------------------------------- matched state */

  function renderMatched(tab, resolved, live) {
    app.replaceChildren();
    for (const node of liveBanner(tab, live, resolved)) app.append(node);

    const swatch = element('div', { className: 'swatch' });
    const title = element('div', { className: 'env', textContent: resolved.label });
    const subtitle = element('div', {
      className: 'tenant',
      textContent: MODE_LABELS[resolved.mode] + ': ' + resolved.pattern
    });
    app.append(element('div', { className: 'identity' }, [
      swatch,
      element('div', { className: 'meta grow' }, [title, subtitle])
    ]));

    const labelInput = element('input', { type: 'text', value: resolved.label, autocomplete: 'off' });
    const initialsInput = element('input', {
      type: 'text',
      value: resolved.initials,
      placeholder: deriveInitials(resolved.label),
      maxLength: MAX_INITIALS,
      autocomplete: 'off'
    });
    const colorInput = element('input', { type: 'color', value: resolved.color });
    const enabledInput = element('input', {
      type: 'checkbox', id: 'enabled', checked: resolved.enabled
    });

    app.append(field('Label', labelInput));
    app.append(field('Favicon letters (up to 3) — blank resets from the label', initialsInput));
    const palette = buildPalette(colorInput, function () { paint(); save(); });
    app.append(palette.grid, field('Custom color', colorInput));

    const toggle = element('div', { className: 'toggle' });
    toggle.append(enabledInput, element('label', {
      htmlFor: 'enabled', textContent: 'Rule is on'
    }));
    app.append(toggle);

    const status = element('span', { className: 'status' });
    app.append(footer([status]));

    /** The swatch doubles as a favicon preview, letters and all. */
    function paint() {
      const color = normalizeHex(colorInput.value) || resolved.color;
      const label = labelInput.value.trim() || resolved.label;
      initialsInput.placeholder = deriveInitials(label);
      swatch.style.background = color;
      swatch.style.color = readableTextOn(color);
      swatch.textContent = initialsInput.value.trim() || deriveInitials(label);
      title.textContent = label;
      palette.repaint();
    }

    const save = debounce(async function () {
      await updateRule(resolved.key, {
        label: labelInput.value.trim() || resolved.label,
        initials: initialsInput.value.trim(),
        color: normalizeHex(colorInput.value) || resolved.color,
        enabled: enabledInput.checked
      });
      status.textContent = 'Saved';
      setTimeout(function () { status.textContent = ''; }, 1400);
    }, 250);

    labelInput.addEventListener('input', function () { paint(); save(); });
    initialsInput.addEventListener('input', function () { paint(); save(); });
    colorInput.addEventListener('input', function () { paint(); save(); });
    // Switching a rule off changes which state the popup belongs in, so re-render.
    enabledInput.addEventListener('change', async function () {
      await updateRule(resolved.key, { enabled: enabledInput.checked });
      await wait(300);
      render();
    });

    paint();
  }

  /* ------------------------------------------------------------ disabled state */

  /**
   * A rule matches but is switched off. Offering to add another rule here would
   * quietly create a duplicate, so offer the switch instead.
   */
  function renderDisabled(tab, rule, live) {
    app.replaceChildren();
    for (const node of liveBanner(tab, live, null)) app.append(node);

    const swatch = element('div', { className: 'swatch' });
    swatch.style.background = rule.color;
    swatch.style.opacity = '.4';
    app.append(element('div', { className: 'identity' }, [
      swatch,
      element('div', { className: 'meta grow' }, [
        element('div', { className: 'env', textContent: rule.label }),
        element('div', {
          className: 'tenant',
          textContent: MODE_LABELS[rule.mode] + ': ' + rule.pattern
        })
      ])
    ]));

    app.append(banner('warn', 'This page has a rule, but the rule is switched off.'));

    const enableButton = element('button', { className: 'action', textContent: 'Switch it on' });
    enableButton.addEventListener('click', async function () {
      enableButton.disabled = true;
      await updateRule(rule.id, { enabled: true });
      await wait(400);
      render();
    });

    app.append(footer([enableButton]));
  }

  /* ------------------------------------------------------------ no-match state */

  function renderAddForm(tab, live) {
    app.replaceChildren();
    for (const node of liveBanner(tab, live, null)) app.append(node);

    let host = tab.url;
    let path = '';
    try {
      const url = new URL(tab.url);
      host = url.hostname;
      path = url.pathname;
    } catch (error) { /* leave the raw URL in place */ }

    const suggested = suggestPattern(tab.url);
    const swatch = element('div', { className: 'swatch' });
    const heading = element('div', { className: 'env', textContent: 'Add a rule' });
    const subtitle = element('div', { className: 'tenant', textContent: host + path, title: tab.url });
    app.append(element('div', { className: 'identity' }, [
      swatch,
      element('div', { className: 'meta grow' }, [heading, subtitle])
    ]));

    const modeSelect = element('select');
    for (const mode of MATCH_MODES) {
      modeSelect.append(element('option', { value: mode, textContent: MODE_LABELS[mode] }));
    }
    modeSelect.value = DEFAULT_MODE;

    const patternInput = element('input', {
      type: 'text', value: suggested, autocomplete: 'off', spellcheck: false
    });
    const labelInput = element('input', { type: 'text', value: host, autocomplete: 'off' });
    const initialsInput = element('input', {
      type: 'text',
      placeholder: deriveInitials(host),
      maxLength: MAX_INITIALS,
      autocomplete: 'off'
    });
    const colorInput = element('input', { type: 'color', value: colorForKey(suggested || host) });

    app.append(field('Match when', modeSelect));
    app.append(field('Pattern — use || between several', patternInput));
    const verdict = element('div', { className: 'banner', style: 'margin:-2px 0 12px' });
    app.append(verdict);
    app.append(field('Label', labelInput));
    app.append(field('Favicon letters (up to 3) — blank resets from the label', initialsInput));
    const palette = buildPalette(colorInput, paint);
    app.append(palette.grid, field('Custom color', colorInput));

    const emphasizeInput = element('input', { type: 'checkbox', id: 'emphasize' });
    const emphasizeToggle = element('div', { className: 'toggle' });
    emphasizeToggle.append(emphasizeInput, element('label', {
      htmlFor: 'emphasize', textContent: 'Extra thick frame (production)'
    }));
    app.append(emphasizeToggle);

    const addButton = element('button', { className: 'action', textContent: 'Add rule' });
    const status = element('span', { className: 'status' });
    app.append(footer([addButton, status]));

    function paint() {
      const color = normalizeHex(colorInput.value) || '#777777';
      const label = labelInput.value.trim() || host;
      initialsInput.placeholder = deriveInitials(label);
      swatch.style.background = color;
      swatch.style.color = readableTextOn(color);
      swatch.textContent = initialsInput.value.trim() || deriveInitials(label);
      palette.repaint();
    }

    /** Live verdict, so a pattern that matches nothing is obvious before it is saved. */
    function validate() {
      const pattern = patternInput.value.trim();
      verdict.className = 'banner bad';
      if (!pattern) {
        verdict.textContent = 'Enter a pattern.';
        addButton.disabled = true;
        return false;
      }
      const expression = compilePattern(pattern, modeSelect.value);
      if (!expression) {
        verdict.textContent = 'Not a valid regular expression.';
        addButton.disabled = true;
        return false;
      }
      addButton.disabled = false;
      const hit = expression.test(tab.url);
      if (hit) {
        verdict.className = 'banner ok';
        verdict.textContent = 'Matches this tab.';
        addButton.textContent = 'Add rule';
      } else if (modeSelect.value === 'wildcard' && wrapForWildcard(pattern) !== pattern) {
        verdict.textContent =
          'Does not match. Wildcard must cover the whole URL — try ' + wrapForWildcard(pattern);
        addButton.textContent = 'Add anyway';
      } else {
        verdict.textContent = 'Does not match this tab.';
        addButton.textContent = 'Add anyway';
      }
      return hit;
    }

    patternInput.addEventListener('input', validate);
    labelInput.addEventListener('input', paint);
    initialsInput.addEventListener('input', paint);
    colorInput.addEventListener('input', paint);
    modeSelect.addEventListener('change', function () {
      patternInput.value = adaptPatternToMode(patternInput.value, modeSelect.value);
      validate();
    });

    addButton.addEventListener('click', async function () {
      const pattern = patternInput.value.trim();
      if (!pattern) return;
      addButton.disabled = true;
      status.textContent = 'Adding…';
      await addRule({
        pattern,
        mode: modeSelect.value,
        label: labelInput.value.trim() || pattern,
        initials: initialsInput.value.trim(),
        color: normalizeHex(colorInput.value),
        emphasize: emphasizeInput.checked,
        enabled: true
      });
      // Give the content script a moment to receive the storage change and repaint,
      // then report what actually happened rather than what should have.
      await wait(400);
      render();
    });

    paint();
    validate();
  }

  /* --------------------------------------------------------------------- entry */

  async function render() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
      app.replaceChildren();
      app.append(banner('warn', 'This kind of page cannot be colored — Chrome blocks '
        + 'extensions on its own pages. Your rules are still editable.'));
      app.append(footer());
      return;
    }

    const [state, live] = await Promise.all([loadState(), pingTab(tab.id)]);
    const resolved = resolveUrl(state, tab.url);
    if (resolved) {
      renderMatched(tab, resolved, live);
      return;
    }
    const [disabled] = matchingRules(state, tab.url, true).filter(function (rule) {
      return rule.enabled === false;
    });
    if (disabled) renderDisabled(tab, disabled, live);
    else renderAddForm(tab, live);
  }

  render();
})();
