# Taco Analyzer UI class contract

Reference for every class defined in `public/styles.css` and every hook read by
`public/app.js`. **This is a contract.** Other agents write the HTML against it,
so the snippets below are copy-pasteable and the structural requirements are
stated as requirements, not suggestions. If a component needs a shape the
stylesheet does not cover, add it to the stylesheet and to this document rather
than reaching for a one-off style attribute.

## Ground rules

1. **No inline styles, no inline scripts, ever.** The app ships
   `Content-Security-Policy: script-src 'self'; style-src 'self'`. A `style="…"`
   attribute or a `<style>` block will be refused by the browser. Everything
   visual comes from `/styles.css`.
2. **Classes are for the stylesheet, `data-*` attributes are for behaviour.**
   `app.js` never keys off a class name. If you rename a class you break the
   look; if you drop a `data-*` hook you break the behaviour. They are listed
   separately for each component.
3. **Mobile first.** Base styles target 360px. Nothing needs a wrapper to
   become responsive except `.data-table`, which is documented in detail.
4. Interactive elements are real interactive elements. A `<div>` with a click
   handler is not acceptable; use `<button type="button">` or `<a href>`.
5. Every page includes, in this order: `.top-stripe`, `.skip-link`,
   `.site-header`, `<main id="main">` containing `.page`, then `.site-footer`.

## Page skeleton

Copy this for every page. `data-theme` on `<html>` is optional: omit it and the
stylesheet follows the OS preference, with dark as the fallback.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Score a taco, Taco Analyzer</title>
    <link rel="stylesheet" href="/styles.css">
    <script src="/app.js" defer></script>
  </head>
  <body>
    <div class="top-stripe"></div>
    <a class="skip-link" href="#main">Skip to main content</a>

    <header class="site-header">
      <a class="wordmark" href="/">
        <span class="wordmark__taco">Taco</span>
        <span class="wordmark__analyzer">Analyzer</span>
      </a>
      <nav class="site-nav" aria-label="Main">
        <a class="site-nav__link" href="/" aria-current="page">Dashboard</a>
        <a class="site-nav__link" href="/surveys">Surveys</a>
        <a class="site-nav__link" href="/surveys/new">New survey</a>
      </nav>
      <button type="button" class="theme-toggle" data-theme-toggle aria-pressed="true">
        <span class="theme-toggle__icon" aria-hidden="true"></span>
        <span class="theme-toggle__label">Dark mode</span>
      </button>
    </header>

    <main id="main" class="page">
      <h1>Score a taco</h1>
      <!-- page content -->
    </main>

    <footer class="site-footer">
      <p>Taco Analyzer. Scores are recorded per visit, per item.</p>
    </footer>
  </body>
</html>
```

Notes on the skeleton:

- `.top-stripe` is an empty decorative `<div>`. It takes no role, no text and no
  `aria-hidden` (an empty div with no role is already invisible to assistive
  tech). It is `position: fixed`, and `body` already reserves its 4px.
- `.skip-link` must be the first focusable element in the document and must
  point at the `id` of the `<main>`. It is off-screen until focused, not
  `display: none`, so it stays in the tab order.
- `<main>` carries `id="main"` and the `.page` class. Do not nest `.page` inside
  another `.page`.
- Set `aria-current="page"` on exactly one `.site-nav__link`.

---

## Theming

| Value | Meaning |
| --- | --- |
| `<html>` with no `data-theme` | Follow the OS. `prefers-color-scheme: light` gives the light palette; anything else gives dark. |
| `<html data-theme="dark">` | Force dark, even when the OS asks for light. |
| `<html data-theme="light">` | Force light, even when the OS asks for dark. |

The selectors are ordered so an explicit `data-theme` always beats the media
query. `data-theme="dark"` needs no rule of its own: it fails both light
selectors, so the base dark tokens on `:root` apply.

`app.js` treats `localStorage['taco-theme']` as the client-side source of truth:

- `'light'` or `'dark'` sets `data-theme` on `<html>` to match.
- Key absent means follow the system, and `app.js` **removes** `data-theme`.
- Any other value is ignored as junk.
- If `localStorage` throws (Safari private mode, storage blocked by policy) the
  choice is held in memory for the page view and the page keeps working.

### Zero-flash rendering (optional server work)

`app.js` is `defer`red, so it runs after the first paint. That is invisible in
the common cases (no stored choice, or a stored choice that matches the OS). It
is a brief flash only when a user has explicitly chosen the theme their OS does
not prefer. If that matters, have the server mirror the choice into a cookie and
render `data-theme` on `<html>` from it; `app.js` reconciles on boot and
`localStorage` still wins. Do not solve it with an inline script: the CSP
forbids it.

### Theme toggle behaviour

- `aria-pressed="true"` means **dark mode is engaged**. `app.js` maintains this
  attribute; render your best guess server-side and it will be corrected.
- `.theme-toggle__label` text is a fixed noun phrase (`Dark mode`). `app.js`
  never rewrites it. The state travels in `aria-pressed`, which is the standard
  toggle-button pattern; a label that changes underneath a pressed state
  double-announces and confuses.
- `.theme-toggle__icon` must be **empty** and `aria-hidden="true"`. Its
  half-filled circle is drawn in CSS and flips sides when pressed, so the state
  is carried by shape as well as by colour.
- Optional: a second button with `data-theme-system` returns to following the
  OS by clearing the storage key. `app.js` disables it when it is already the
  current state.

```html
<button type="button" class="theme-toggle" data-theme-system aria-pressed="false">
  <span class="theme-toggle__label">Use system theme</span>
</button>
```

---

## Verified contrast ratios

Every ratio below was computed from the token hexes with the WCAG 2.x relative
luminance formula. Thresholds: **4.5:1** body text, **3:1** large text (>= 24px,
or >= 18.66px bold) and UI component boundaries (WCAG 1.4.11).

### Dark theme, on page `#121114` / surface `#1B1A1F` / raised `#232228`

| Token | Hex | page | surface | raised | Requirement | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `--text` | `#EDEBF0` | 15.90 | 14.61 | 13.33 | 4.5 | pass |
| `--muted` | `#A79FB0` | 7.37 | 6.78 | 6.18 | 4.5 | pass (no adjustment needed) |
| `--border-control` | `#7A7488` | 4.19 | 3.86 | 3.52 | 3.0 | pass |
| `--focus-ring` | `#2ED9C3` | 10.60 | 9.74 | 8.89 | 3.0 | pass |
| `--accent-purple-text` | `#C08FE0` | 7.39 | 6.79 | 6.20 | 4.5 | pass |
| `--accent-magenta-text` | `#FF4D9D` | 6.09 | 5.60 | 5.11 | 4.5 | pass |
| `--accent-teal-text` | `#2ED9C3` | 10.60 | 9.74 | 8.89 | 4.5 | pass |
| `--accent-yellow-text` | `#FFC72C` | 12.06 | 11.08 | 10.11 | 4.5 | pass |
| `--selected-border` | `#9B4FC0` | 3.83 | 3.52 | 3.21 | 3.0 | pass |
| `--danger-border` | `#FF4D9D` | 6.09 | 5.60 | 5.11 | 3.0 | pass |
| `--disabled-text` on `#1F1E23` | `#8A8496` | 4.59 | | | exempt | pass anyway |

### Light theme, on page `#FAF9FB` / surface `#FFFFFF` / raised `#F2F0F5`

| Token | Hex | page | surface | raised | Requirement | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `--text` | `#1A1820` | 16.74 | 17.57 | 15.52 | 4.5 | pass |
| `--muted` | `#5C5567` | 6.78 | 7.12 | 6.29 | 4.5 | pass |
| `--border-control` | `#857E91` | 3.71 | 3.90 | 3.44 | 3.0 | pass |
| `--focus-ring` | `#6E2A8C` | 8.43 | 8.85 | 7.82 | 3.0 | pass |
| `--accent-purple-text` | `#6E2A8C` | 8.43 | 8.85 | 7.82 | 4.5 | pass |
| `--accent-magenta-text` | `#AE0F5E` | 6.60 | 6.93 | 6.13 | 4.5 | pass |
| `--accent-teal-text` | `#00767A` | 5.17 | 5.42 | 4.79 | 4.5 | pass |
| `--accent-yellow-text` | `#7A5300` | 6.53 | 6.85 | 6.06 | 4.5 | pass |
| `--selected-border` | `#6E2A8C` | 8.43 | 8.85 | 7.82 | 3.0 | pass |
| `--warn-border` | `#A87200` | 3.94 | 4.14 | 3.66 | 3.0 | pass |
| `--disabled-text` on `#EFEDF2` | `#8A8395` | 3.14 | | | exempt | acceptable |

### Text on accent fills

| Pairing | Ratio | Requirement | Verdict |
| --- | --- | --- | --- |
| `#EDEBF0` on selected purple `#6E2A8C` (dark) | 7.48 | 4.5 | pass |
| `#FFFFFF` on selected purple `#6E2A8C` (light) | 8.85 | 4.5 | pass |
| `#FFFFFF` on danger `#C4126A` (both themes) | 5.77 | 4.5 | pass |
| `#1A1820` on teal `#00B3B8` | 6.81 | 4.5 | pass |
| `#1A1820` on yellow `#FFC72C` | 11.26 | 4.5 | pass |

### Pairings that FAILED and were therefore designed around

These are the reason the `--accent-*-text` and `--border-control` tokens exist
instead of using the raw brand hexes and the supplied grey borders directly.

| Rejected pairing | Ratio | Needed | Replacement |
| --- | --- | --- | --- |
| `--tb-purple` `#6E2A8C` as text on dark page | **2.13** | 4.5 | `--accent-purple-text` `#C08FE0` (7.39) |
| `--tb-magenta` `#E5177E` as text on dark page | **4.26** | 4.5 | `--accent-magenta-text` `#FF4D9D` (6.09) |
| `--tb-magenta` `#E5177E` as text on white | **4.42** | 4.5 | `--accent-magenta-text` `#AE0F5E` (6.93) |
| `--tb-teal` `#00B3B8` as text on white | **2.58** | 4.5 | `--accent-teal-text` `#00767A` (5.42) |
| `--tb-yellow` `#FFC72C` as text or border on white | **1.56** | 4.5 / 3.0 | text `#7A5300` (6.85), border `#A87200` (4.14) |
| `--border` `#33313A` as a control boundary on dark | **1.47** | 3.0 | `--border-control` `#7A7488` (4.19) |
| `--border-strong` `#4A4753` as a control boundary on dark | **2.08** | 3.0 | same |
| `--border` `#DDD9E3` as a control boundary on light | **1.39** | 3.0 | `--border-control` `#857E91` (3.90) |
| `--border-strong` `#B9B3C4` as a control boundary on light | **2.04** | 3.0 | same |
| `--tb-purple` fill as its own boundary on dark page | **2.13** | 3.0 | 2px `#9B4FC0` border added (3.83) |
| `#C4126A` danger fill as its own boundary on raised dark | **2.74** | 3.0 | 2px `#FF4D9D` border added (5.11) |
| `#2ED9C3` focus ring drawn directly on white | n/a | 3.0 | ring switches to `#6E2A8C` on light (8.85) |

**Consequences you must respect when writing HTML:**

- `--border` and `--border-strong` are **decorative hairlines only** (card
  edges, table row rules, list separators). Never put them on something a user
  clicks or types into. Interactive boundaries come from `--border-control`,
  which components already apply for you.
- Never put an accent colour on body text yourself. Use `.text-muted` or the
  component classes; the accent text tokens are applied for you and are already
  theme-correct.

### The focus ring gap, and why it is an `outline`

Under the light theme the focus ring (`#6E2A8C`) and the selected scale chip
fill (`#6E2A8C`) are the same colour, a 1.00 ratio against each other. The ring
is drawn with `outline` plus `outline-offset: 2px`, so the ring never touches
the fill: the 2px gap is painted with the surface behind the control, and the
ring reads against that surface at **8.85:1**. The same applies to the danger
button (ring vs `#C4126A` fill is 1.53, ring vs surface is 8.85). Do not replace
any focus ring with a `box-shadow` or remove `outline-offset`.

### Forced colours

A `@media (forced-colors: active)` block hands every colour back to the OS while
keeping the shape signals (border weight, the check indicator, the caret
rotation). No component depends on a colour surviving that mode.

### Never colour alone

Every stateful component carries at least two non-colour signals. Summary:

| Component | Non-colour signals |
| --- | --- |
| `.flash--*` | Bold text label, distinct icon glyph, 5px inline-start stripe |
| `.error-summary` | Text heading, X icon, diamond list markers, 2px border |
| `.field-error` | X icon, bold weight, text content |
| `.is-invalid` control | Border 1px to 2px, inset 3px inline-start edge |
| `.scale` checked chip | Border 1px to 2px solid, filled background, check indicator appears, bold weight |
| `.score-badge--*` | Tier word in text, the numeral, border weight 1/2/3px, dashed on `--weak` |
| `.site-nav__link[aria-current]` | Bottom border appears, weight and colour change |
| `.pagination__link[aria-current]` | Fill, 2px border, weight 800 |
| `.theme-toggle` | Icon fill flips side, border weight, `aria-pressed` |
| `.progress-meter[data-complete]` | Track border 1px to 2px, text colour |

---

## Layout and chrome

| Class | Element | Notes |
| --- | --- | --- |
| `.top-stripe` | `<div>` | Empty. Fixed, 4px, purple to magenta to teal gradient. One per page. |
| `.skip-link` | `<a href="#main">` | First focusable element. Hidden off-screen until focused. |
| `.site-header` | `<header>` | Flex, wraps. Order: wordmark, nav, theme toggle. |
| `.wordmark` | `<a href="/">` | Uppercase, letterspaced. Two spans required. |
| `.wordmark__taco` | `<span>` | First word, neutral text colour. |
| `.wordmark__analyzer` | `<span>` | Second word, the one magenta accent. |
| `.site-nav` | `<nav aria-label="Main">` | The `aria-label` is required; there may be more than one nav on a page. |
| `.site-nav__link` | `<a>` | Set `aria-current="page"` on the active one. 44px tall. |
| `.theme-toggle` | `<button type="button">` | Needs `data-theme-toggle` and `aria-pressed`. |
| `.theme-toggle__icon` | `<span aria-hidden="true">` | Must be empty. |
| `.theme-toggle__label` | `<span>` | Fixed text `Dark mode`. |
| `.page` | `<main id="main">` or `<div>` | Max 44rem, the form column. |
| `.page--wide` | modifier on `.page` | Max 68rem, for dashboards and tables. |
| `.site-footer` | `<footer>` | Muted small text. |

`.page--wide` example:

```html
<main id="main" class="page page--wide">
  <h1>Dashboard</h1>
</main>
```

---

## Feedback

### `.flash`

Server-rendered banner at the top of `.page`. Choose the role by urgency:
`role="status"` for success and info (announced politely, does not interrupt),
`role="alert"` for errors (announced immediately). The `.flash__label` is
**mandatory**: it is what makes the meaning survive greyscale, and it is what a
screen reader reads first. The icon is decorative and drawn in CSS.

```html
<p class="flash flash--success" role="status">
  <span class="flash__icon" aria-hidden="true"></span>
  <span class="flash__body">
    <strong class="flash__label">Saved</strong>
    <span class="flash__message">Your survey for El Buen Taco was recorded.</span>
  </span>
</p>
```

```html
<p class="flash flash--error" role="alert">
  <span class="flash__icon" aria-hidden="true"></span>
  <span class="flash__body">
    <strong class="flash__label">Not saved</strong>
    <span class="flash__message">The photo could not be written to disk. Try again.</span>
  </span>
</p>
```

Variants: `.flash--success` (teal, check), `.flash--error` (magenta, X),
`.flash--info` (purple, italic i), `.flash--warn` (yellow, exclamation).
`.flash--warn` is the **only** place yellow appears in the whole app.

`.flash__label` gets a `": "` from CSS `::after`, so do not write your own colon.
If you use `<div>` instead of `<p>`, everything still works; `.flash p` has its
margin zeroed so a paragraph inside a div-based flash is fine too.

### `.error-summary`

Rendered at the top of `.page` when a submit failed validation, **above** the
form. Requirements: `role="alert"`, `tabindex="-1"`, and `data-error-summary` so
`app.js` can move focus to it. Every list item links to the `id` of the control
that failed; `app.js` upgrades those links so they focus the control and not just
scroll to it.

```html
<div class="error-summary" role="alert" tabindex="-1" data-error-summary>
  <h2 class="error-summary__title">3 problems need fixing</h2>
  <ul class="error-summary__list">
    <li class="error-summary__item">
      <a class="error-summary__link" href="#business_name">Enter the business or location name</a>
    </li>
    <li class="error-summary__item">
      <a class="error-summary__link" href="#price_cents">Menu price must be a number like 3.50</a>
    </li>
    <li class="error-summary__item">
      <a class="error-summary__link" href="#taste-filling_flavor">Score the filling flavor</a>
    </li>
  </ul>
</div>
```

Rules:

- Only one `[data-error-summary]` per page. `app.js` focuses the first it finds.
- The message text must be the **same wording** as the matching `.field-error`,
  so a user who jumps to a field does not read a second, different sentence.
- Link `href` targets: for a normal control, the control's own `id`. For a
  `.scale`, the `id` on the `<fieldset class="scale">`. `app.js` detects a
  fieldset target and focuses the checked radio, or the first radio, so arrow
  keys work on arrival.
- The title is an `<h2>` inside a `role="alert"` container. Do not add
  `aria-live`; `role="alert"` already implies `aria-live="assertive"`, and both
  together double-announce.

### `.field-error`

The inline message. Must have an `id`, and that `id` must appear in the
control's `aria-describedby`. See the field snippets below for the full wiring.

```html
<p class="field-error" id="business_name-error">Enter the business or location name</p>
```

### `.empty-state`

```html
<div class="empty-state">
  <h2 class="empty-state__title">No surveys yet</h2>
  <p class="empty-state__body">
    Score your first taco and this page starts filling in with averages,
    consistency and value.
  </p>
  <div class="empty-state__actions">
    <a class="btn btn--primary" href="/surveys/new">Start a survey</a>
  </div>
</div>
```

`.empty-state__actions` is optional; drop it when there is nothing to do.

---

## Forms

### Shape of a form

```html
<form class="form" method="post" action="/surveys" enctype="multipart/form-data" novalidate>
  <p class="form__intro text-muted">
    Every question is required unless it is marked <span class="optional-marker">Optional</span>.
  </p>

  <fieldset class="form-section">
    <legend class="form-section__legend">The visit</legend>
    <p class="form-section__blurb">Where and when. One of these per trip.</p>

    <!-- .field and .scale blocks -->
  </fieldset>

  <div class="form-actions form-actions--sticky">
    <button type="submit" class="btn btn--primary btn--block">Save survey</button>
  </div>
</form>
```

| Class | Element | Notes |
| --- | --- | --- |
| `.form` | `<form>` | Grid, `gap: 2rem` between sections. |
| `.form--validated` | modifier on `<form>` | Add **only** when re-rendering a submission that failed. Enables native `:invalid` painting. Never on a first render. |
| `.form__intro` | `<p>` | The "everything is required unless marked" sentence. |
| `.form-section` | `<fieldset>` | Required element type. Borderless on mobile, a bordered card from 768px up. |
| `.form-section__legend` | `<legend>` | Required as the fieldset's first child. |
| `.form-section__blurb` | `<p>` | Optional. Must come directly after the legend for its spacing to be right. |

`novalidate` on the `<form>` is recommended: the server is the authority, error
messages are consistent that way, and it stops the browser from putting up its
own popup that competes with `.error-summary`. If you leave native validation on,
that is also fine; `required` is still set on every control either way, because
that is what assistive tech announces.

### `.field`

The standard label / hint / control / error block. The DOM order is fixed:
**label, hint, control, error.** That order is what makes the visual order match
the order `aria-describedby` reads them in.

```html
<div class="field">
  <label class="field__label" for="business_name">Business or location name</label>
  <p class="field__hint" id="business_name-hint">The name on the sign. Truck, stand, restaurant, or stall.</p>
  <input
    type="text"
    id="business_name"
    name="business_name"
    maxlength="160"
    autocomplete="organization"
    required
    aria-describedby="business_name-hint">
</div>
```

With a validation failure, add `.is-invalid`, `aria-invalid="true"`, and append
the error `id` to `aria-describedby` (hint first, error second):

```html
<div class="field">
  <label class="field__label" for="business_name">Business or location name</label>
  <p class="field__hint" id="business_name-hint">The name on the sign. Truck, stand, restaurant, or stall.</p>
  <input
    type="text"
    id="business_name"
    name="business_name"
    class="is-invalid"
    aria-invalid="true"
    required
    aria-describedby="business_name-hint business_name-error">
  <p class="field-error" id="business_name-error">Enter the business or location name</p>
</div>
```

| Class | Element | Notes |
| --- | --- | --- |
| `.field` | `<div>` | Grid, 0.5rem gap. Has `scroll-margin` so error-summary jumps clear the sticky bar. |
| `.field__label` | `<label for>` | `for` is mandatory. Never wrap the control instead. |
| `.field__hint` | `<p>` | Needs an `id` referenced by `aria-describedby`. |
| `.field__control` | `<div>` | **Optional** wrapper, only needed when a control needs a sibling (see money below) or a width cap. A bare control as a direct child of `.field` is the normal case. |
| `.is-invalid` | on the control | Server-set. Pair with `aria-invalid="true"`. |

### Controls that are styled with no class at all

These are styled by element selector, so they need no class:
`input[type=text]`, `[type=number]`, `[type=date]`, `[type=password]`,
`[type=email]`, `[type=search]`, `[type=tel]`, `[type=url]`, `select`,
`textarea`.

All of them get `font-size: 1rem` (16px). **Do not override that downward.**
Anything under 16px makes iOS Safari zoom the viewport when the field is focused,
which on this form means losing your place in a row of nine radio chips.

- `select` keeps its native `appearance` on purpose, so the platform draws the
  chevron and no icon file or data URI is needed. `color-scheme` on `:root` is
  what makes that chevron light on the dark theme. Room is already reserved for
  it with `padding-inline-end`.
- `input[type=number]` has its spinner buttons removed (a 12px target beside a
  44px field is not usable one-handed). Pair it with `inputmode`.
- `:disabled` renders as a dashed border plus muted text: two signals, no opacity
  drop, because opacity would pull the border under its measured contrast.
- `[readonly]` renders as a solid quiet fill with muted text and a normal cursor.

```html
<div class="field">
  <label class="field__label" for="visited_on">Date of visit</label>
  <input type="date" id="visited_on" name="visited_on" required>
</div>

<div class="field">
  <label class="field__label" for="state">State</label>
  <select id="state" name="state" required>
    <option value="">Choose a state</option>
    <option value="ME">Maine</option>
  </select>
</div>

<div class="field">
  <label class="field__label" for="notes">
    Notes
    <span class="optional-marker">Optional</span>
  </label>
  <p class="field__hint" id="notes-hint">Anything the rubric does not capture.</p>
  <textarea id="notes" name="notes" rows="4" maxlength="4000" aria-describedby="notes-hint"></textarea>
</div>
```

### Required and optional markers: the decision

Nearly every question on this form is required. Marking the required ones would
decorate almost every label with an asterisk that carries no information, and
would bury the one thing a user actually needs to spot: which field they are
allowed to skip.

**So the form does the opposite.** It states once, in `.form__intro`, that
everything is required unless marked, and only the rare optional field carries
`.optional-marker`. `.required-marker` still exists for a future mixed form, but
nothing in the taco survey should use it.

Neither marker is the accessible source of truth. The `required` attribute on the
control is what assistive tech announces, so it must always be present on a
required control regardless of visible marking.

```html
<!-- The rare optional field. Inside the label, so it joins the accessible name. -->
<label class="field__label" for="notes">
  Notes
  <span class="optional-marker">Optional</span>
</label>

<!-- Only for a mixed form. The asterisk is decorative; `required` does the work. -->
<label class="field__label" for="town">
  Town or city
  <span class="required-marker" aria-hidden="true">*</span>
</label>
```

### `.input--money` and `.input-prefix`

The `$` is a decorative prefix and **must** be `aria-hidden="true"`. The currency
belongs in the hint text, where a screen reader will actually reach it in a
useful order. `.input-group` owns the border and the focus ring; the inner input
gives up both.

```html
<div class="field">
  <label class="field__label" for="price_cents">Menu price</label>
  <p class="field__hint" id="price_cents-hint">The listed price in US dollars, before tax and tip.</p>
  <div class="field__control">
    <div class="input-group">
      <span class="input-prefix" aria-hidden="true">$</span>
      <input
        class="input--money"
        type="text"
        inputmode="decimal"
        id="price_cents"
        name="price_cents"
        required
        aria-describedby="price_cents-hint">
    </div>
  </div>
</div>
```

`type="text"` with `inputmode="decimal"` rather than `type="number"`: the server
parser (`parseMoneyToCents`) already accepts `12.50`, `$12.50` and `1,250.00`,
and `type="number"` silently discards a value the browser considers malformed
before it is ever submitted.

### `.input--qty`

No prefix, so no `.input-group` is needed.

```html
<div class="field">
  <label class="field__label" for="qty">Tacos included at that price</label>
  <p class="field__hint" id="qty-hint">Enter 1 for a single taco.</p>
  <input
    class="input--qty"
    type="number"
    inputmode="numeric"
    min="1"
    max="100"
    step="1"
    id="qty"
    name="qty"
    required
    aria-describedby="qty-hint">
</div>
```

Both `.input--money` and `.input--qty` cap their own width (11rem and 7rem), and
`.input-group` inherits the cap when it wraps one. On a 44rem desktop column that
stops a three-character value from getting a 600px box.

### `.form-actions`

```html
<div class="form-actions form-actions--sticky">
  <button type="submit" class="btn btn--primary btn--block">Save survey</button>
  <p class="form-actions__note">Nothing is saved until you press Save.</p>
</div>
```

- `.form-actions--sticky` uses `position: sticky`, not `fixed`. Sticky stays in
  normal flow, so the bar occupies real space at the end of the form and can
  never sit on top of the last field once the form is scrolled to the bottom.
- `env(safe-area-inset-bottom)` is added to its block-end padding, so the buttons
  clear the home indicator on a notched phone.
- It stops being sticky at 768px and above, where the actions simply sit at the
  end of the form.
- `html { scroll-padding-block-end }` and `.field { scroll-margin-block-end }`
  keep error-summary jumps from landing behind the bar.

### `.photo-field`

`data-photo-field` is what activates the preview and the pre-upload check. Every
inner hook is optional: leave out `[data-photo-image]` and the checks still run,
they just report in text.

```html
<div class="field photo-field" data-photo-field data-max-bytes="8388608">
  <label class="field__label" for="photo">
    Photo of the taco
    <span class="optional-marker">Optional</span>
  </label>
  <p class="field__hint" id="photo-hint">JPEG, PNG, WEBP or HEIC, up to 8 MB.</p>
  <input
    class="photo-field__input"
    type="file"
    id="photo"
    name="photo"
    accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
    capture="environment"
    aria-describedby="photo-hint">

  <div class="photo-field__preview" data-photo-preview>
    <img class="photo-field__image" alt="" data-photo-image>
    <p class="photo-field__filename" data-photo-filename></p>
  </div>

  <p class="photo-field__message" role="status" data-photo-message></p>
</div>
```

| Attribute | Read by | Meaning |
| --- | --- | --- |
| `data-photo-field` | app.js | Activates the feature. Put it on the wrapper. |
| `data-max-bytes` | app.js | Size ceiling in bytes. Defaults to 8388608 (8 MB). |
| `data-accept` | app.js | Comma-separated MIME allowlist. Defaults to JPEG, PNG, WEBP, AVIF, HEIC, HEIF. Keep it in sync with the `accept` attribute and with the server. |
| `data-photo-preview` | app.js | The wrapper shown once a file is chosen. |
| `data-photo-image` | app.js | The `<img>`. Ship it with `alt=""` and no `src`; app.js sets both. |
| `data-photo-filename` | app.js | Optional `<p>` for the file name. |
| `data-photo-message` | app.js | Required `role="status"`, rendered **empty**. app.js writes the friendly result here. |
| `data-has-preview` | written by app.js | Present on the wrapper once a thumbnail is showing. CSS keeps `.photo-field__preview` at `display: none` until then. |
| `data-tone` | written by app.js | `info`, `warn` or `error` on the message element. Do not set it yourself. |

Behaviour notes:

- The object URL is revoked when the selection is replaced and again on
  `pagehide`, so changing your mind five times leaks nothing.
- A rejected file is cleared from the input, so a submit cannot carry it.
- Files with an empty `File.type` (some Android pickers) fall back to a filename
  extension check.
- **The server still validates authoritatively.** This is a courtesy so a user on
  a phone tether does not spend 40 seconds uploading a file that will be
  refused.

### `.progress-meter`

The text **must be rendered server-side with the correct starting numbers**, and
it must carry `aria-live="polite"` in the served markup so the live region is
registered before the first update. With JavaScript off the text is simply
correct and static, and the decorative bar stays hidden.

```html
<div class="progress-meter" data-progress-meter data-total="11">
  <p class="progress-meter__text" data-progress-text aria-live="polite">0 of 11 questions answered</p>
  <div class="progress-meter__track" aria-hidden="true">
    <div class="progress-meter__bar" data-progress-bar></div>
  </div>
</div>
```

| Attribute | Read by | Meaning |
| --- | --- | --- |
| `data-progress-meter` | app.js | Activates the feature. |
| `data-total` | app.js | Total question count. Authoritative, because the server knows the rubric. If omitted, app.js counts distinct radio group names. |
| `data-progress-form` | app.js | Optional `id` of the form to count. Defaults to the enclosing `<form>`, then `<body>`. |
| `data-template` | app.js | Optional. Default `{answered} of {total} questions answered`. Both placeholders are replaced. |
| `data-progress-text` | app.js | The live text node. Needs `aria-live="polite"`. |
| `data-progress-bar` | app.js | The fill element. |
| `data-enhanced` | written by app.js | Added to the meter on boot. CSS reveals the track only then, because without JS there is no way to set a fill width and a bar frozen at zero next to correct text would be a lie. |
| `data-complete` | written by app.js | Added when answered >= total. Thickens the track border. |
| `--progress` | written by app.js | A `0`-to-`1` number set on the bar via `style.setProperty`. This is a CSSOM write on a live element, not a `style` attribute in served HTML, so `style-src 'self'` permits it and no `'unsafe-inline'` is needed. |

Counting rule: one "question" is one distinct radio group `name`. It counts as
answered when any radio in that group is checked. Text inputs are not counted.
Announcements are debounced 250ms, because arrowing across the nine options of a
scale fires a `change` event per step.

---

## `.scale`, the rubric metric control

Nine discrete options (1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5) rendered as **nine
real `<input type="radio">` elements sharing one `name`**. There is no JavaScript
in this component at all: native radios already give arrow-key navigation that
moves focus and changes the selection in one step, native `required` validation
across the group, and native form serialisation.

### The full snippet, copy this exactly

```html
<fieldset class="scale" id="taste-filling_flavor">
  <legend class="scale__legend">Filling flavor</legend>

  <details class="scale__anchors">
    <summary class="scale__anchors-summary">What 1, 3 and 5 mean</summary>
    <dl class="scale__anchor-list">
      <div class="scale__anchor">
        <dt>1</dt>
        <dd>Bland, off, or poor-quality protein/main. Little going on.</dd>
      </div>
      <div class="scale__anchor">
        <dt>3</dt>
        <dd>Tasty, competently cooked, recognizable and satisfying.</dd>
      </div>
      <div class="scale__anchor">
        <dt>5</dt>
        <dd>Distinct, memorable, clearly excellent sourcing or technique.</dd>
      </div>
    </dl>
  </details>

  <div class="scale__options">
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="taste-filling_flavor-1" name="taste.filling_flavor" value="1" required>
      <label class="scale__label" for="taste-filling_flavor-1"><span class="scale__number">1</span></label>
    </div>
    <div class="scale__option scale__option--half">
      <input class="scale__input" type="radio" id="taste-filling_flavor-1_5" name="taste.filling_flavor" value="1.5" required>
      <label class="scale__label" for="taste-filling_flavor-1_5"><span class="scale__number">1.5</span></label>
    </div>
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="taste-filling_flavor-2" name="taste.filling_flavor" value="2" required>
      <label class="scale__label" for="taste-filling_flavor-2"><span class="scale__number">2</span></label>
    </div>
    <div class="scale__option scale__option--half">
      <input class="scale__input" type="radio" id="taste-filling_flavor-2_5" name="taste.filling_flavor" value="2.5" required>
      <label class="scale__label" for="taste-filling_flavor-2_5"><span class="scale__number">2.5</span></label>
    </div>
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="taste-filling_flavor-3" name="taste.filling_flavor" value="3" required>
      <label class="scale__label" for="taste-filling_flavor-3"><span class="scale__number">3</span></label>
    </div>
    <div class="scale__option scale__option--half">
      <input class="scale__input" type="radio" id="taste-filling_flavor-3_5" name="taste.filling_flavor" value="3.5" required>
      <label class="scale__label" for="taste-filling_flavor-3_5"><span class="scale__number">3.5</span></label>
    </div>
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="taste-filling_flavor-4" name="taste.filling_flavor" value="4" required>
      <label class="scale__label" for="taste-filling_flavor-4"><span class="scale__number">4</span></label>
    </div>
    <div class="scale__option scale__option--half">
      <input class="scale__input" type="radio" id="taste-filling_flavor-4_5" name="taste.filling_flavor" value="4.5" required>
      <label class="scale__label" for="taste-filling_flavor-4_5"><span class="scale__number">4.5</span></label>
    </div>
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="taste-filling_flavor-5" name="taste.filling_flavor" value="5" required>
      <label class="scale__label" for="taste-filling_flavor-5"><span class="scale__number">5</span></label>
    </div>
  </div>

  <p class="scale__ends" aria-hidden="true">
    <span>1 poor</span>
    <span>5 exceptional</span>
  </p>
</fieldset>
```

### Non-negotiable structural rules

1. **The wrapper is a `<fieldset>` and the question is its `<legend>`.** That is
   what groups the nine radios under one question name for assistive tech. A
   `<div>` with an `aria-labelledby` is not an acceptable substitute here.
2. **Nine `.scale__option` children of `.scale__options`, in ascending order,
   alternating `--whole`, `--half`, `--whole`, ... ending on `--whole`.** The
   grid column template is `repeat(4, 1.15fr 0.9fr) 1.15fr`, which assumes
   exactly that order. Getting it wrong does not break the layout, but the wrong
   chips will be the wide ones.
3. **The `<input>` must be the immediate previous sibling of its `<label>`,**
   with nothing between them. The focus ring is drawn by
   `.scale__input:focus-visible + .scale__label`. Insert anything between them
   and keyboard users lose the ring entirely.
4. **`.scale__input` keeps the `.scale__input` class, not `.visually-hidden`.**
   It is clipped with the same technique but is a component part, and mixing in
   the utility risks a specificity collision.
5. **All nine radios share one `name`** and each carries `required`. One `name`
   is what gives arrow-key navigation; `required` on any member makes the whole
   group required.
6. **`id` on the `<fieldset>`** so `.error-summary` links can target the
   question. `app.js` focuses the checked radio (or the first) on arrival.
7. **`for` on every label** pointing at its input's `id`. Do not wrap the input
   inside the label; the sibling combinator in rule 3 depends on it being outside.
8. `.scale__number` wraps the digits so the CSS check indicator is a sibling in
   the label's flex column rather than trailing the text.
9. `.scale__ends` is `aria-hidden="true"`. The same information is in the
   `<details>` in a form a screen reader can actually use, and repeating it as a
   bare "1 poor 5 exceptional" fragment mid-group is noise.

### Naming convention for `id` and `name`

- `name` is `<sectionKey>.<metricKey>`, matching `server/rubrics/taco_v1.js`:
  `taste.filling_flavor`, `context.serving_temp`, `observer.hunger`. The dot and
  the brackets in `items[0].taste.tortilla` are safe: `app.js` only ever puts
  the name inside a quoted attribute selector and escapes quotes and
  backslashes.
- `id` is `<sectionKey>-<metricKey>` on the fieldset, and
  `<sectionKey>-<metricKey>-<value with . replaced by _>` on each input. A dot in
  an `id` is legal HTML but a nuisance in a CSS selector and in a URL fragment,
  so it is replaced.
- For item-scoped sections on a multi-item survey, prefix with the item index:
  `items[0].taste.filling_flavor` and `items-0-taste-filling_flavor`.

### Layout math at 360px

```
360  viewport
-32  .page padding-inline (16 each side)
---- 328  content column
 -0  .form-section has no horizontal padding on mobile, by design
 -0  .scale has no horizontal padding on mobile, by design
---- 328  .scale__options width
-16  eight 2px column gaps
---- 312  shared across nine chips

total  = (5 x 1.15fr) + (4 x 0.9fr) = 9.35fr
whole  = 312 x 1.15 / 9.35 = 38.4px
half   = 312 x 0.90 / 9.35 = 30.0px
```

Both clear the 24px minimum target size of WCAG 2.5.8, and every chip is 44px
tall. **No horizontal scroll at 360px.** This is why `.form-section` and `.scale`
carry no horizontal padding on mobile: the full fieldset box would cost 24px and
squeeze the half-step chips. The boxes come back at 768px.

### Whole numbers versus half steps

Whole numbers are the primary choice and read as stronger through four things at
once: a wider grid column (1.15fr vs 0.9fr), a larger font size, `font-weight:
700` vs `500`, a raised background, and a solid border where halves are dashed.
Half steps stay fully reachable and are the same 44px tall.

### Checked state

Four simultaneous signals, only one of which is colour:

1. border goes 1px to **2px solid** (halves lose their dash),
2. the background **fills** with purple,
3. a **check indicator appears** below the numeral (drawn from two borders,
   space permanently reserved so the chip does not change height under a thumb
   that is mid-tap),
4. weight goes to **700**.

Label text on the fill is 7.48:1 on dark and 8.85:1 on light.

### `.scale--five`, the integer-only variant

Used by the observer-variable questions (hunger, emotional state, distance from
home), which the rubric scores in whole numbers only. Five equal columns, every
chip styled as a whole number, no `--whole` / `--half` distinction.

```html
<fieldset class="scale scale--five" id="observer-hunger">
  <legend class="scale__legend">Hunger</legend>

  <details class="scale__anchors">
    <summary class="scale__anchors-summary">What each level means</summary>
    <dl class="scale__anchor-list">
      <div class="scale__anchor"><dt>1</dt><dd>Not really hungry; just something to do.</dd></div>
      <div class="scale__anchor"><dt>2</dt><dd>Snackish.</dd></div>
      <div class="scale__anchor"><dt>3</dt><dd>I could eat.</dd></div>
      <div class="scale__anchor"><dt>4</dt><dd>Hungry enough to eat a horse.</dd></div>
      <div class="scale__anchor"><dt>5</dt><dd>So hungry it hurts.</dd></div>
    </dl>
  </details>

  <div class="scale__options">
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="observer-hunger-1" name="observer.hunger" value="1" required>
      <label class="scale__label" for="observer-hunger-1"><span class="scale__number">1</span></label>
    </div>
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="observer-hunger-2" name="observer.hunger" value="2" required>
      <label class="scale__label" for="observer-hunger-2"><span class="scale__number">2</span></label>
    </div>
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="observer-hunger-3" name="observer.hunger" value="3" required>
      <label class="scale__label" for="observer-hunger-3"><span class="scale__number">3</span></label>
    </div>
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="observer-hunger-4" name="observer.hunger" value="4" required>
      <label class="scale__label" for="observer-hunger-4"><span class="scale__number">4</span></label>
    </div>
    <div class="scale__option scale__option--whole">
      <input class="scale__input" type="radio" id="observer-hunger-5" name="observer.hunger" value="5" required>
      <label class="scale__label" for="observer-hunger-5"><span class="scale__number">5</span></label>
    </div>
  </div>

  <p class="scale__ends" aria-hidden="true">
    <span>1 low</span>
    <span>5 high</span>
  </p>
</fieldset>
```

`.scale--five` still uses `.scale__option--whole` on all five. Keep the class so
the whole-number treatment applies.

### `.scale__anchors`

A `<details>`, **collapsed by default**. The rubric anchor text is long and only
needed when a score is genuinely borderline; leaving it open makes the form
unscannable. Do not add `open`.

- `<summary class="scale__anchors-summary">` gets a CSS-drawn caret that rotates
  when open, so the disclosure state is carried by rotation and not by a glyph
  that may be missing from a system font. The native marker is suppressed.
- `.scale__anchor-list` is a `<dl>`. Each label/value pair is wrapped in a
  `<div class="scale__anchor">`, which is valid HTML inside a `<dl>` and lets the
  pair be a grid row.
- Use the exact anchor strings from `server/rubrics/taco_v1.js`. A metric with
  1/3/5 anchors shows three rows; an observer variable with all five shows five.

### An invalid `.scale`

Add `.is-invalid` to the `<fieldset>` (there is no single input to outline) and a
`.field-error` inside it, wired to the group with `aria-describedby` on the
fieldset.

```html
<fieldset class="scale is-invalid" id="taste-tortilla" aria-describedby="taste-tortilla-error">
  <legend class="scale__legend">Tortilla</legend>
  <!-- anchors and options -->
  <p class="field-error" id="taste-tortilla-error">Score the tortilla from 1 to 5</p>
</fieldset>
```

| Class | Element | Notes |
| --- | --- | --- |
| `.scale` | `<fieldset>` | Required element. Needs an `id`. |
| `.scale--five` | modifier | Integer-only 1 to 5. Five options instead of nine. |
| `.scale__legend` | `<legend>` | The question. First child. |
| `.scale__anchors` | `<details>` | Collapsed. No `open`. |
| `.scale__anchors-summary` | `<summary>` | Direct child of `.scale__anchors`. |
| `.scale__anchor-list` | `<dl>` | |
| `.scale__anchor` | `<div>` | Wraps one `<dt>` / `<dd>` pair. |
| `.scale__options` | `<div>` | The grid. Exactly 9 (or 5) children. |
| `.scale__option` | `<div>` | One chip cell. Needs `--whole` or `--half`. |
| `.scale__option--whole` | modifier | 1, 2, 3, 4, 5. |
| `.scale__option--half` | modifier | 1.5, 2.5, 3.5, 4.5. |
| `.scale__input` | `<input type="radio">` | Clipped, focusable. Immediately before its label. |
| `.scale__label` | `<label for>` | The visible chip. |
| `.scale__number` | `<span>` | The digits. |
| `.scale__ends` | `<p aria-hidden="true">` | Two spans, start and end. |

---

## Buttons

`.btn` works on both `<button>` and `<a>`. Always give a `<button>` an explicit
`type`; a bare `<button>` inside a form defaults to `type="submit"`.

```html
<button type="submit" class="btn btn--primary">Save survey</button>
<button type="button" class="btn btn--secondary">Add another taco</button>
<a class="btn btn--secondary" href="/surveys">Back to surveys</a>
<button type="submit" class="btn btn--danger">Delete this survey</button>
<button type="button" class="btn btn--secondary btn--small">Edit</button>
<button type="submit" class="btn btn--primary btn--block">Save survey</button>
<button type="submit" class="btn btn--primary" disabled>Saving</button>
<a class="btn btn--quiet" href="/surveys">Cancel</a>
```

| Class | Notes |
| --- | --- |
| `.btn` | Base. 44px tall, 44px minimum width. |
| `.btn--primary` | Purple fill, white label (8.85:1). Carries a 2px `--tb-purple-lt` border on dark, because the fill alone is only 2.13:1 against the page and would fail the 3:1 boundary rule. |
| `.btn--secondary` | Transparent, `--border-control` outline. |
| `.btn--danger` | Magenta family. Fill `#C4126A` with white text (5.77:1) and a lighter magenta 2px border for the boundary. Reserved for destructive actions. |
| `.btn--small` | 32px tall, still over the 24px WCAG 2.5.8 floor. For table rows and card footers. **Never for a submit.** |
| `.btn--block` | Full width. Reverts to intrinsic width at 1024px, where a full-width slab looks broken. |
| `.btn--quiet` | Underlined, borderless. For "cancel". |
| `:disabled` | Dashed border plus muted text, no opacity drop. `[aria-disabled="true"]` gets the same look; prefer real `disabled` unless the button must stay focusable. |

Destructive actions must be a `<form method="post">` submit, never a link, so
they cannot be triggered by a prefetch or a crawler:

```html
<form class="cluster" method="post" action="/surveys/12/delete">
  <button type="submit" class="btn btn--danger btn--small">Delete survey</button>
</form>
```

---

## Data display

### `.stat-grid` / `.stat-card`

One column at 360px, two from 480px, auto-fit from 1024px.

```html
<div class="stat-grid">
  <div class="stat-card">
    <p class="stat-card__value text-nums">18</p>
    <h2 class="stat-card__label">Surveys</h2>
    <p class="stat-card__detail">Across 11 businesses</p>
  </div>
  <div class="stat-card">
    <p class="stat-card__value text-nums">3.9</p>
    <h2 class="stat-card__label">Mean taste score</h2>
    <p class="stat-card__detail">Out of 5, six-metric average</p>
  </div>
</div>
```

The value comes **before** the label in the DOM (it is the thing being read) but
the label is the heading. `.stat-card__detail` is optional. `.stat-card__value`
already uses tabular numerals; `.text-nums` is belt and braces and harmless.

### `.score-badge`

Both parts are required. The **numeral and the tier word are always present**, so
the tier survives greyscale, colour blindness and forced-colours mode. Border
weight also steps by tier (3px strong, 2px mid, 1px dashed weak).

```html
<span class="score-badge score-badge--strong">
  <span class="score-badge__value text-nums">4.5</span>
  <span class="score-badge__tier">Strong</span>
</span>

<span class="score-badge score-badge--mid">
  <span class="score-badge__value text-nums">3.2</span>
  <span class="score-badge__tier">Mid</span>
</span>

<span class="score-badge score-badge--weak">
  <span class="score-badge__value text-nums">1.8</span>
  <span class="score-badge__tier">Weak</span>
</span>
```

Tier colours: `--strong` teal, `--mid` purple, `--weak` neutral grey. Yellow is
not used here because it is reserved for warnings, and magenta is not used here
because it is reserved for the wordmark and destructive actions. If the badge
needs more context than the tier word, wrap it in a `<span class="visually-hidden">`
sentence beside it rather than relying on the colour.

### `.data-table`

**Read this whole section before writing a table.** Base styles are the stacked
card layout for narrow screens; the real table layout is restored at 768px.

Because `display` is changed on table elements, Chromium and WebKit drop the
native table semantics. **Explicit ARIA roles are therefore mandatory** on every
table element. They are inert when the real table layout is active and
load-bearing when it is not.

**Every `<td>` must carry `data-label="<its column header>"`.** The stacked view
renders that attribute as the row label. A `<td>` without it has no heading on a
phone.

```html
<table class="data-table" role="table">
  <caption class="data-table__caption">Tacos scored on this visit</caption>
  <thead role="rowgroup">
    <tr role="row">
      <th role="columnheader" scope="col">Item</th>
      <th role="columnheader" scope="col" class="data-table__num">Price</th>
      <th role="columnheader" scope="col" class="data-table__num">Taste</th>
      <th role="columnheader" scope="col"><span class="visually-hidden">Actions</span></th>
    </tr>
  </thead>
  <tbody role="rowgroup">
    <tr role="row">
      <td role="cell" data-label="Item">Taco de Carne Asada</td>
      <td role="cell" data-label="Price" class="data-table__num text-nums">$3.50</td>
      <td role="cell" data-label="Taste" class="data-table__num text-nums">4.2</td>
      <td role="cell" data-label="">
        <div class="data-table__actions">
          <a class="btn btn--secondary btn--small" href="/items/8">View</a>
        </div>
      </td>
    </tr>
  </tbody>
</table>
```

| Requirement | Why |
| --- | --- |
| `role="table"` on `<table>` | `display: block` on rows strips the implicit role. |
| `role="rowgroup"` on `<thead>` and `<tbody>` | Same. |
| `role="row"` on every `<tr>` | Same. |
| `role="columnheader"` and `scope="col"` on every `<th>` | Same, plus the scope is what associates the column. |
| `role="cell"` on every `<td>` | Same. |
| `data-label` on every `<td>` | Becomes the row label in the stacked view. |
| `data-label=""` on an actions cell | Suppresses the label so buttons span the full row width. |
| `.data-table__caption` on `<caption>` | Names the table. Add one whenever the surrounding heading does not already do the job. |
| `.data-table__num` | Tabular numerals, and right-aligned once the real table appears. Put it on the `<th>` **and** the matching `<td>`. |
| `.data-table__actions` | Flex wrapper for buttons inside a cell. |

Do not wrap `.data-table` in a horizontally scrolling container. The stacked
layout is the narrow-screen answer; a scroll container would fight it.

### `.card`

```html
<article class="card">
  <header class="card__header">
    <h2 class="card__title"><a href="/surveys/12">El Buen Taco</a></h2>
    <span class="badge">Taco rubric v1</span>
  </header>
  <div class="card__body">
    <p>Bangor, ME. Visited Jul 18, 2026.</p>
    <dl class="meta-list">
      <div class="meta-list__row">
        <dt class="meta-list__label">Taste score</dt>
        <dd class="meta-list__value text-nums">4.2 of 5</dd>
      </div>
      <div class="meta-list__row">
        <dt class="meta-list__label">Serving temp</dt>
        <dd class="meta-list__value text-nums">3.5 of 5</dd>
      </div>
      <div class="meta-list__row">
        <dt class="meta-list__label">Value</dt>
        <dd class="meta-list__value text-nums">4 of 5</dd>
      </div>
    </dl>
  </div>
  <footer class="card__footer">
    <a class="btn btn--secondary btn--small" href="/surveys/12">Open</a>
  </footer>
</article>
```

| Class | Element | Notes |
| --- | --- | --- |
| `.card` | `<article>` or `<div>` | |
| `.card__header` | `<header>` | Raised fill, bottom hairline. |
| `.card__title` | `<h2>` / `<h3>` | Pick the level that fits the page outline. |
| `.card__aside` | `<span>` / `<div>` | Optional trailing header slot. Pushed to the far edge, as are a `.badge` or `.score-badge` placed directly in the header. |
| `.card__body` | `<div>` | Grid, 0.75rem gap. |
| `.card__footer` | `<footer>` | Optional. Flex, wraps. |

### `.badge`

```html
<span class="badge">Visit 2</span>
<span class="badge badge--accent">Re-visit</span>
```

Neutral pill. `.badge--accent` adds a purple boundary and purple text. A badge is
text, so it needs no `aria-hidden` and no extra labelling.

### `.meta-list`

A `<dl>`. **Each label/value pair must be wrapped in a
`<div class="meta-list__row">`,** which is valid inside a `<dl>` and is what makes
the pair a grid row. Stacked at 360px, two columns from 768px.

```html
<dl class="meta-list">
  <div class="meta-list__row">
    <dt class="meta-list__label">Business</dt>
    <dd class="meta-list__value">El Buen Taco</dd>
  </div>
  <div class="meta-list__row">
    <dt class="meta-list__label">Menu price</dt>
    <dd class="meta-list__value text-nums">$3.50</dd>
  </div>
</dl>
```

### `.photo-thumb`

```html
<a class="photo-thumb-link" href="/uploads/abc123.jpg">
  <img class="photo-thumb" src="/uploads/abc123-thumb.jpg" width="320" height="240"
       alt="Two carne asada tacos on a paper plate">
</a>

<img class="photo-thumb photo-thumb--small" src="/uploads/abc123-thumb.jpg"
     width="160" height="160" alt="">
```

- `.photo-thumb` is 4:3 and caps at 14rem. `.photo-thumb--small` is square and
  caps at 5rem.
- Always set `width` and `height` attributes so the layout does not jump.
- `alt` describes the photo when it carries information. Use `alt=""` when it is
  decorative or when an adjacent caption already says the same thing.
- `.photo-thumb-link` exists so the focus ring wraps the link, not the image.

### `.pagination`

```html
<nav class="pagination" aria-label="Survey pages">
  <ul class="pagination__list">
    <li><span class="pagination__link--disabled" aria-hidden="true">Previous</span></li>
    <li><a class="pagination__link" href="?page=1" aria-current="page">1</a></li>
    <li><a class="pagination__link" href="?page=2">2</a></li>
    <li><span class="pagination__ellipsis" aria-hidden="true">...</span></li>
    <li><a class="pagination__link" href="?page=9">9</a></li>
    <li><a class="pagination__link" href="?page=2">Next</a></li>
  </ul>
</nav>
```

- The `<nav>` needs `aria-label`, since a page may have more than one nav.
- `aria-current="page"` on exactly one link. That, not the fill colour, is what
  conveys the current page.
- An unavailable Previous or Next is a `<span class="pagination__link--disabled">`,
  **not** a link. A disabled link is a dead focus stop.
- Give the numeric links a visually hidden prefix when the surrounding context
  does not make them obvious: `<a class="pagination__link" href="?page=2"><span
  class="visually-hidden">Page </span>2</a>`.

---

## Utilities

| Class | Effect |
| --- | --- |
| `.visually-hidden` | Removes visually, keeps in the accessibility tree and the tab order. Uses the 1px clip-path technique, not `display: none`. |
| `.visually-hidden--focusable` | Add alongside `.visually-hidden` to reveal the element when it or anything inside it takes focus. |
| `.text-muted` | `--muted` colour. Passes 4.5:1 on all three surfaces in both themes. |
| `.text-mono` | Mono face plus tabular numerals. For prices, scores, ids. |
| `.text-nums` | Tabular numerals without switching face. Use this in prose. |
| `.text-small` | 0.8125rem. **Never on a form control.** |
| `.stack` | Vertical rhythm on `> * + *` only, so the block adds no outer margin. Default 1rem. |
| `.stack--tight` / `.stack--loose` | 0.5rem / 2rem steps. |
| `.cluster` | Horizontal flex that wraps, 0.75rem gap, centre aligned. |
| `.cluster--between` / `.cluster--end` | Justification modifiers. |

`.stack` and `.cluster` are tunable per instance through custom properties, but
since inline styles are forbidden, set them from a component rule in the
stylesheet rather than on the element:

```
--stack-space     the gap .stack puts between siblings
--cluster-space   the gap .cluster uses
--cluster-align   .cluster align-items, default center
```

```html
<div class="stack stack--tight">
  <p>First.</p>
  <p>Second.</p>
</div>

<div class="cluster cluster--between">
  <h2>Surveys</h2>
  <a class="btn btn--primary btn--small" href="/surveys/new">New</a>
</div>
```

`.visually-hidden` is a positioning utility and this stylesheet uses no
`!important` anywhere, so it must be the **only** positioning class on an
element. Do not combine it with a component class that sets `position`.

---

## Print

`@media print` remaps the tokens to ink on paper and drops everything
interactive, so a submitted survey fits on one sheet with no extra markup:

- Hidden: `.top-stripe`, `.skip-link`, `.site-nav`, `.theme-toggle`,
  `.form-actions`, `.pagination`, `.progress-meter`, `.site-footer`,
  `.photo-field__input`, `.scale__anchors`, `.empty-state__actions`,
  `.data-table__actions`, `.btn`, `.form-section__blurb`, `.field__hint`,
  `.scale__ends`.
- A `.scale` prints **only the chosen chip**, as a bordered value. An unanswered
  scale prints `(not answered)`, so a gap on the record is visible.
- `.data-table` prints as a real table with a repeating header, regardless of
  paper width.
- `break-inside: avoid` is set on `.field`, `.scale`, `.card`, `.stat-card`,
  table rows and `.meta-list__row`.
- External link hrefs are printed after the link text.

Nothing needs a `print` class. If a page needs something else suppressed, add it
to the hide list in the print section rather than inventing a utility.

---

## Full class index

**Chrome:** `.top-stripe` `.skip-link` `.site-header` `.wordmark`
`.wordmark__taco` `.wordmark__analyzer` `.site-nav` `.site-nav__link`
`.theme-toggle` `.theme-toggle__icon` `.theme-toggle__label` `.page` `.page--wide`
`.site-footer`

**Feedback:** `.flash` `.flash--success` `.flash--error` `.flash--info`
`.flash--warn` `.flash__icon` `.flash__body` `.flash__label` `.flash__message`
`.error-summary` `.error-summary__title` `.error-summary__list`
`.error-summary__item` `.error-summary__link` `.field-error` `.empty-state`
`.empty-state__title` `.empty-state__body` `.empty-state__actions`

**Forms:** `.form` `.form--validated` `.form__intro` `.form-section`
`.form-section__legend` `.form-section__blurb` `.field` `.field__label`
`.field__hint` `.field__control` `.is-invalid` `.required-marker`
`.optional-marker` `.input-group` `.input-prefix` `.input--money` `.input--qty`
`.form-actions` `.form-actions--sticky` `.form-actions__note` `.photo-field`
`.photo-field__input` `.photo-field__preview` `.photo-field__image`
`.photo-field__filename` `.photo-field__message` `.progress-meter`
`.progress-meter__text` `.progress-meter__track` `.progress-meter__bar`

**Scale:** `.scale` `.scale--five` `.scale__legend` `.scale__anchors`
`.scale__anchors-summary` `.scale__anchor-list` `.scale__anchor`
`.scale__options` `.scale__option` `.scale__option--whole`
`.scale__option--half` `.scale__input` `.scale__label` `.scale__number`
`.scale__ends`

**Buttons:** `.btn` `.btn--primary` `.btn--secondary` `.btn--danger`
`.btn--small` `.btn--block` `.btn--quiet`

**Data display:** `.stat-grid` `.stat-card` `.stat-card__value`
`.stat-card__label` `.stat-card__detail` `.score-badge` `.score-badge--strong`
`.score-badge--mid` `.score-badge--weak` `.score-badge__value`
`.score-badge__tier` `.data-table` `.data-table__caption` `.data-table__num`
`.data-table__actions` `.card` `.card__header` `.card__title` `.card__aside`
`.card__body` `.card__footer` `.badge` `.badge--accent` `.meta-list`
`.meta-list__row` `.meta-list__label` `.meta-list__value` `.photo-thumb`
`.photo-thumb--small` `.photo-thumb-link` `.pagination` `.pagination__list`
`.pagination__link` `.pagination__link--disabled` `.pagination__ellipsis`

**Utilities:** `.visually-hidden` `.visually-hidden--focusable` `.text-muted`
`.text-mono` `.text-nums` `.text-small` `.stack` `.stack--tight` `.stack--loose`
`.cluster` `.cluster--between` `.cluster--end`

### Attribute index

**You write these:** `data-theme` (on `<html>`), `data-theme-toggle`,
`data-theme-system`, `data-photo-field`, `data-max-bytes`, `data-accept`,
`data-photo-preview`, `data-photo-image`, `data-photo-filename`,
`data-photo-message`, `data-progress-meter`, `data-total`, `data-progress-form`,
`data-template`, `data-progress-text`, `data-progress-bar`,
`data-error-summary`, `data-label` (on every `<td>`).

**app.js writes these, do not set them yourself:** `data-theme-source`,
`data-has-preview`, `data-tone`, `data-enhanced`, `data-complete`, and the
`--progress` custom property on `.progress-meter__bar`.
