# Color Coded Clients

A Chrome extension that colors a page by URL, so you always know which customer's
system you are about to change something in.

You define the rules. Nothing is detected or guessed: a page is colored when one of
your patterns matches its URL, and left alone otherwise.

Built because the off-the-shelf environment markers ([Environment Marker][em],
[Environment Indicator][ei], [URLColors][uc]) inject their label once at page load, and
a single-page app like the Business Central client rebuilds its DOM afterwards and
wipes it. Everything here is re-applied on a `MutationObserver` and mounted on
`documentElement` rather than inside the page's own layout, so it survives.

[em]: https://chromewebstore.google.com/detail/environment-marker/ahjhdebcnlgmojdmjnhikhakkghcchkk
[ei]: https://chromewebstore.google.com/detail/environment-indicator/kgdbcpllbbnimjgoiomfdebldcofmlbl
[uc]: https://chromewebstore.google.com/detail/urlcolors/jjccpcminoppplpmcfghflolejbdkekm

## Rules

An ordered list. The first enabled rule whose pattern matches the URL paints the page,
so put the specific rules above the general ones. Three matching modes:

| Mode | Example | Matches |
| --- | --- | --- |
| URL contains | `dev.azure.com/stacc` | anywhere in the URL, case-insensitive, regex characters literal |
| Wildcard | `*dynamics.com*/Production*` | **the whole URL**, with `*` spanning anything |
| Regular expression | `dynamics\.com/.+/Prod` | your own regex, case-insensitive |

Wildcard is anchored at both ends, which is the easy mistake: `example.com` matches
nothing, because the real URL has `https://` in front of it. Write `*example.com*`. The
popup wraps the pattern for you when you switch to wildcard mode, and says so when a
pattern does not match the tab you are on.

**One rule can cover several sites** by separating patterns with `||`, so a customer on
more than one hostname needs one label and one color rather than a duplicate per host:

```
*core.brage.no*||*core.leabank.no*
```

Each alternative is matched on its own, so in wildcard mode each one needs its own `*`
wrapping. `||` works in *contains* and *wildcard*; *regex* already has `|`.

## What gets colored

| Signal | Where you see it | Color range |
| --- | --- | --- |
| Viewport frame | A border around the page, always visible while you work | Any hex |
| On-page label | Any of six positions, 9–48px | Any hex |
| Favicon | The tab strip, bookmarks, history | Any hex |
| Title prefix | Tab label, window title, Windows taskbar, Alt+Tab | — |
| Toolbar icon + badge | Chrome's toolbar, per tab | Any hex |
| Tab group | Chrome's tab strip, above the page (off by default) | Chrome's 9 group colors |

Frame width (1–15px), label position (top/bottom × left/centre/right) and label size
(9–48px) are sliders in options, sharing one live preview that shows the real pixel
sizes. Tick **Bold** on a rule to draw its frame at twice the width, for the
environments where a mistake costs the most.

**Favicon letters** are per rule, up to three characters, shared with the toolbar badge.
Leave the field blank and they follow the label — `core.leabank.no` gives `CL`, `Acme
Bank PROD` gives `AB` — or set them explicitly when the initials collide. The swatch in
the popup previews them live.

## What Chrome does not allow

- **The window frame, toolbar, omnibox and bookmarks bar cannot be recolored** by an
  extension. Chrome themes are a separate extension type declared with a `"theme"`
  manifest key, they contain no JavaScript, and there is no runtime API to swap or
  scope one. Firefox has `theme.update()` with a per-window `windowId`; Chrome has no
  equivalent. For a tinted window frame, use one Chrome **profile** per major customer.
- **`<meta name="theme-color">` is Android-only** and does nothing on desktop Chrome.
- **Tab groups accept only nine named colors**, not arbitrary hex. Your color is
  snapped to the nearest one.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select this folder
4. **Reload any tabs that were already open** — content scripts only inject into pages
   loaded after the extension is

That last step is the usual reason nothing appears on a first install. The popup detects
it and offers a reload button rather than leaving you guessing. After *editing* the
code, see Develop below: the extension has to be reloaded too, and that is a separate
step from reloading the page.

## Use

Click the toolbar icon on any page:

- **A rule already covers it** — edit the label and color inline.
- **A rule covers it but is switched off** — one button to switch it back on, rather
  than silently offering a duplicate rule.
- **Nothing covers it** — an add-rule form with the pattern pre-filled from the URL and
  a live verdict telling you whether it matches as you type.
- **The page can never be colored** (a `chrome://` page, say) — the rule list is still
  one click away.

A banner at the top always reports what the page is *actually* showing, obtained by
pinging the content script rather than inferred from the rules. Every state ends with
an **All rules** link, so the toolbar button is never a dead end.

The options page (right-click the icon → Options) has the full rule list with
reordering, a URL tester, the label controls, and JSON export/import for sharing one
scheme across the team.



## Layout

```
manifest.json          MV3 manifest
src/lib/palette.js     16-color palette, hashing, contrast, tab-group snapping
src/lib/rules.js       Pattern matching, storage, rule resolution
src/content.js         Frame, label, favicon, title; re-applied as the page re-renders
src/background.js      Toolbar icon and badge, tab groups
src/popup.*            Edit the current page's rule, re-enable one, or add one
src/options.*          Rule list, URL tester, label controls, export/import
tools/make-icons.ps1   Regenerates icons/*.png
tools/package.ps1      Builds the Web Store zip
tests/rules.test.js    46 tests over matching, resolution and settings
```

The `src/lib/*.js` files are plain scripts that attach to `globalThis`, so the same file
loads in the content script, the service worker (`importScripts`), the popup, the
options page, and Node's test runner without a build step. No bundler, no dependencies.

## Develop

```
npm test      # node --test tests/*.test.js
npm run icons # regenerate the PNG icons
```

### Reloading after a change

Chrome does **not** hot-reload an unpacked extension: it keeps running the code it was
loaded with until you reload the extension itself, and reloading a *tab* only re-injects
the content script the extension already had. So editing a file does nothing until you
press the **↻ reload icon on the extension's card** at `chrome://extensions`.

Open tabs used to need reloading by hand as well. The service worker now re-injects the
content script into every open tab on install and update, so reloading the extension is
enough on its own.

Two version stamps catch a stale copy when something still looks wrong:

- The options heading and popup footer show `manifest.json`'s version. If it is not the
  version in the file on disk, the extension was never reloaded.
- The popup compares its version against the content script actually running in the tab
  and says so in red when they differ, because everything else it reports would then be
  describing code that is not running.

## Known limits

- Settings live in `chrome.storage.sync`, capped at 8 KB for a single item — roughly 60
  rules. Past that, switch to `chrome.storage.local` in `rules.js` and lose
  cross-device sync.
- The frame overlays the page rather than shrinking it, so it covers a few pixels of
  the right-hand scrollbar. Scrolling still works.
- URL changes inside a single-page app are picked up by a 750ms poll, so a route change
  can show the previous color briefly.
- Earlier versions auto-detected Business Central environments. That layer is gone;
  anything it had stored is dropped on first load, and rules are unaffected.
