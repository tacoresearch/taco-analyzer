/**
 * Taco Analyzer, progressive enhancement.
 *
 * Loaded as `<script src="/app.js" defer>`. No dependencies, no build step, no
 * globals: everything below lives inside one IIFE. The app is server rendered
 * and fully usable with this file blocked or failing to parse; nothing here is
 * required for a survey to be filled in and submitted.
 *
 * What it enhances:
 *
 *   1. Theme toggle       Reads and writes localStorage['taco-theme'] (values
 *                         'light' | 'dark'; the key being absent means "follow
 *                         the system"), mirrors the choice onto
 *                         <html data-theme>, and keeps
 *                         `.theme-toggle[aria-pressed]` truthful. Re-syncs when
 *                         the OS preference changes while no explicit choice is
 *                         stored. Survives localStorage throwing (Safari
 *                         private mode, storage disabled) by falling back to an
 *                         in-memory value for the session.
 *
 *   2. Photo preview      Client-side thumbnail via URL.createObjectURL, plus a
 *                         friendly type and size pre-check before the user
 *                         spends upload time on a file the server will reject.
 *                         Object URLs are revoked when replaced and on pagehide.
 *                         The server is still the authority on what is
 *                         acceptable; this is only a courtesy.
 *
 *   3. Progress meter     Counts answered radio groups and updates the
 *                         server-rendered "N of M questions answered" text in
 *                         place. The text node carries aria-live="polite" in
 *                         the markup, so updates are announced without stealing
 *                         focus. Announcements are debounced, because arrowing
 *                         through a nine-option scale fires a change event per
 *                         step.
 *
 *   4. Error summary      Moves focus to the `role="alert" tabindex="-1"` error
 *                         summary after a failed submit, and makes its links
 *                         actually focus the control they point at (browsers
 *                         scroll to a fragment but do not reliably focus it).
 *
 * Conventions used throughout:
 *   - Features are registered independently and each runs inside its own
 *     try/catch, so one missing element or one unsupported API cannot stop the
 *     others from initialising.
 *   - Behaviour is opted into with `data-*` hooks, never by class name. Classes
 *     belong to the stylesheet; renaming one must not break behaviour.
 *   - Event delegation on the nearest stable container rather than per-element
 *     listeners, so server-rendered markup can be swapped without rebinding.
 *   - No inline styles are ever written. The one dynamic value (the progress
 *     bar fill) is a custom property set through the CSSOM, which the
 *     `style-src 'self'` policy does not gate; the served HTML has no `style`
 *     attributes at all.
 */

(() => {
  'use strict';

  /* ======================================================================
     Small shared helpers
     ====================================================================== */

  /** @type {(root: ParentNode, sel: string) => Element[]} */
  const all = (root, sel) => Array.from(root.querySelectorAll(sel));

  /**
   * Run a feature, swallowing anything it throws. A broken feature must never
   * take the rest of the page with it.
   * @param {string} name
   * @param {() => void} fn
   */
  const feature = (name, fn) => {
    try {
      fn();
    } catch (error) {
      // Reported, not rethrown. The console is the right place for this: the
      // user is standing in a taco line and cannot act on it.
      console.warn(`[taco-analyzer] ${name} did not initialise:`, error);
    }
  };

  /**
   * Trailing-edge debounce.
   * @template {(...args: any[]) => void} F
   * @param {F} fn
   * @param {number} wait
   */
  const debounce = (fn, wait) => {
    let timer = 0;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), wait);
    };
  };

  /**
   * Read an integer from a data attribute, falling back when absent or junk.
   * @param {Element} el
   * @param {string} attr
   * @param {number} fallback
   */
  const intAttr = (el, attr, fallback) => {
    const raw = el.getAttribute(attr);
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };

  /* ======================================================================
     1. Theme toggle
     ====================================================================== */

  const THEME_KEY = 'taco-theme';
  const THEMES = new Set(['light', 'dark']);

  /**
   * localStorage wrapper that degrades to a session-lifetime memory store.
   * Access is wrapped rather than feature-detected once, because Safari in
   * private mode exposes the object and throws on write, and some managed
   * browsers throw on read as well.
   */
  const store = (() => {
    /** @type {Map<string, string>} */
    const memory = new Map();

    return {
      /** @param {string} key */
      get(key) {
        try {
          const value = window.localStorage.getItem(key);
          if (value !== null) return value;
        } catch {
          /* fall through to memory */
        }
        return memory.get(key) ?? null;
      },
      /**
       * @param {string} key
       * @param {string} value
       */
      set(key, value) {
        memory.set(key, value);
        try {
          window.localStorage.setItem(key, value);
        } catch {
          /* memory copy already holds it for this page view */
        }
      },
      /** @param {string} key */
      remove(key) {
        memory.delete(key);
        try {
          window.localStorage.removeItem(key);
        } catch {
          /* nothing more to do */
        }
      },
    };
  })();

  const initTheme = () => {
    const root = document.documentElement;
    const lightQuery = window.matchMedia?.('(prefers-color-scheme: light)') ?? null;

    /** The stored explicit choice, or null when following the system. */
    const storedTheme = () => {
      const value = store.get(THEME_KEY);
      return value !== null && THEMES.has(value) ? value : null;
    };

    /** What the user is actually looking at right now. */
    const effectiveTheme = () => {
      const explicit = storedTheme();
      if (explicit !== null) return explicit;
      return lightQuery?.matches ? 'light' : 'dark';
    };

    /**
     * Push the current decision onto <html> and onto every toggle button.
     * Dark is the stylesheet default and the media query already handles the
     * system case, so following the system means removing the attribute rather
     * than writing a value into it.
     */
    const apply = () => {
      const explicit = storedTheme();
      if (explicit === null) {
        root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', explicit);
      }

      const isDark = effectiveTheme() === 'dark';

      for (const button of all(document, '[data-theme-toggle]')) {
        // aria-pressed reads as "dark mode is engaged". The visible label is a
        // fixed noun phrase ("Dark mode") authored in the HTML and is never
        // rewritten here, which is the standard toggle-button pattern: the name
        // stays put and the state travels in aria-pressed.
        button.setAttribute('aria-pressed', String(isDark));
        // Exposed for styling and for debugging which branch produced the view.
        button.setAttribute('data-theme-source', explicit === null ? 'system' : 'user');
      }

      for (const button of all(document, '[data-theme-system]')) {
        button.setAttribute('aria-pressed', String(explicit === null));
        // A no-op button is worse than a disabled one; this is already the state.
        button.toggleAttribute('disabled', explicit === null);
      }
    };

    // Reconcile at once. The server may have rendered data-theme from a cookie;
    // localStorage is the client-side source of truth, so it wins here.
    apply();

    // One delegated listener for every toggle on the page, present or future.
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const toggle = target.closest('[data-theme-toggle]');
      if (toggle) {
        store.set(THEME_KEY, effectiveTheme() === 'dark' ? 'light' : 'dark');
        apply();
        return;
      }

      const systemButton = target.closest('[data-theme-system]');
      if (systemButton) {
        store.remove(THEME_KEY);
        apply();
      }
    });

    // Follow the OS while no explicit choice is stored. addEventListener on a
    // MediaQueryList is the modern API; older WebKit only has addListener, and
    // an engine with neither simply does not get live OS following.
    const onSystemChange = () => {
      if (storedTheme() === null) apply();
    };
    if (typeof lightQuery?.addEventListener === 'function') {
      lightQuery.addEventListener('change', onSystemChange);
    } else if (typeof lightQuery?.addListener === 'function') {
      lightQuery.addListener(onSystemChange);
    }

    // Another tab changed the choice. `storageArea` may be null in some
    // engines, so the key is what is checked.
    window.addEventListener('storage', (event) => {
      if (event.key === THEME_KEY || event.key === null) apply();
    });
  };

  /* ======================================================================
     2. Photo field: preview plus pre-upload checks
     ====================================================================== */

  const PHOTO_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
  const PHOTO_DEFAULT_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/heic',
    'image/heif',
  ];
  // Some Android and desktop pickers hand over an empty File.type. Extensions
  // are the fallback, never the primary check.
  const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp|avif|heic|heif)$/i;

  /** @param {number} bytes */
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const initPhotoFields = () => {
    const fields = all(document, '[data-photo-field]');
    if (fields.length === 0) return;

    for (const field of fields) {
      const input = field.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) continue;

      const preview = field.querySelector('[data-photo-preview]');
      const image = field.querySelector('[data-photo-image]');
      const filename = field.querySelector('[data-photo-filename]');
      const message = field.querySelector('[data-photo-message]');

      const maxBytes = intAttr(field, 'data-max-bytes', PHOTO_DEFAULT_MAX_BYTES);
      const acceptRaw = field.getAttribute('data-accept');
      const accepted = acceptRaw
        ? acceptRaw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
        : PHOTO_DEFAULT_TYPES;

      /** The object URL currently held for this field, if any. */
      let objectUrl = null;

      const releaseUrl = () => {
        if (objectUrl === null) return;
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      };

      /**
       * @param {string} text
       * @param {'info' | 'warn' | 'error'} tone
       */
      const say = (text, tone) => {
        if (!message) return;
        message.textContent = text;
        if (text === '') {
          message.removeAttribute('data-tone');
        } else {
          message.setAttribute('data-tone', tone);
        }
      };

      const clearPreview = () => {
        releaseUrl();
        field.removeAttribute('data-has-preview');
        if (image instanceof HTMLImageElement) {
          image.removeAttribute('src');
          image.alt = '';
        }
        if (filename) filename.textContent = '';
      };

      /**
       * Reject a file: drop it from the input so a submit cannot carry it, and
       * explain why in plain language.
       * @param {string} reason
       */
      const reject = (reason) => {
        input.value = '';
        clearPreview();
        say(reason, 'error');
      };

      input.addEventListener('change', () => {
        const file = input.files?.[0];

        if (!file) {
          clearPreview();
          say('', 'info');
          return;
        }

        const type = (file.type || '').toLowerCase();
        const typeLooksRight = type
          ? accepted.includes(type)
          : PHOTO_EXTENSIONS.test(file.name);

        if (!typeLooksRight) {
          const pretty = accepted
            .map((t) => t.replace('image/', '').toUpperCase())
            .join(', ');
          reject(`That file is not a photo we can read. Pick a ${pretty} image.`);
          return;
        }

        if (file.size > maxBytes) {
          reject(
            `That photo is ${formatBytes(file.size)}, over the ` +
              `${formatBytes(maxBytes)} limit. Retake it at a smaller size or ` +
              'pick a different one.',
          );
          return;
        }

        if (file.size === 0) {
          reject('That file is empty. Try taking the photo again.');
          return;
        }

        // Replace, so a user who changes their mind five times leaks nothing.
        releaseUrl();

        if (!(image instanceof HTMLImageElement) || !preview) {
          // No preview slot in the markup, but the checks above still ran.
          say(`${file.name} ready to upload (${formatBytes(file.size)}).`, 'info');
          return;
        }

        objectUrl = URL.createObjectURL(file);
        image.src = objectUrl;
        // A thumbnail of a photo the user just took needs a name, not a
        // description this script cannot possibly produce.
        image.alt = `Preview of the selected photo, ${file.name}`;
        field.setAttribute('data-has-preview', '');
        if (filename) filename.textContent = file.name;
        say(`Ready to upload (${formatBytes(file.size)}).`, 'info');
      });

      // The image element keeps the blob alive until the document goes away;
      // pagehide covers the back/forward cache path that unload does not.
      window.addEventListener('pagehide', releaseUrl);
    }
  };

  /* ======================================================================
     3. Progress meter
     ====================================================================== */

  const initProgressMeters = () => {
    const meters = all(document, '[data-progress-meter]');
    if (meters.length === 0) return;

    for (const meter of meters) {
      // Scope: an explicit form id wins, then the enclosing form, then the
      // document. A dashboard could in principle meter something outside a form.
      const formId = meter.getAttribute('data-progress-form');
      const scope =
        (formId ? document.getElementById(formId) : null) ??
        meter.closest('form') ??
        document.body;
      if (!scope) continue;

      const text = meter.querySelector('[data-progress-text]');
      const bar = meter.querySelector('[data-progress-bar]');
      const template =
        meter.getAttribute('data-template') ??
        '{answered} of {total} questions answered';

      /** Distinct radio group names inside the scope, in document order. */
      const groupNames = () => {
        const names = new Set();
        for (const input of all(scope, 'input[type="radio"][name]')) {
          if (input instanceof HTMLInputElement && input.name) names.add(input.name);
        }
        return names;
      };

      // The total is fixed for the life of the page, so it is read once. The
      // server-rendered data-total is authoritative when present, because the
      // server knows the rubric; counting the DOM is the fallback.
      const discovered = groupNames().size;
      const total = intAttr(meter, 'data-total', discovered) || discovered;
      if (total === 0) continue;

      // Names in this app look like `taste.filling_flavor` and
      // `items[0].taste.tortilla`. They are interpolated into a *quoted*
      // attribute value, where the only characters that need escaping are the
      // quote and the backslash; dots and brackets are literal inside quotes.
      // That is why CSS.escape (which is for bare identifiers) is not used here.
      const escapeName = (value) => value.replace(/["\\]/g, '\\$&');

      const countAnswered = () => {
        let answered = 0;
        for (const name of groupNames()) {
          const selector = `input[type="radio"][name="${escapeName(name)}"]:checked`;
          if (scope.querySelector(selector)) answered += 1;
        }
        return answered;
      };

      /** Paint the visual state at once. This never waits on the debounce. */
      const render = (answered) => {
        const ratio = total > 0 ? Math.min(1, answered / total) : 0;
        if (bar instanceof HTMLElement) {
          // A CSSOM custom-property write, not a `style` attribute in served
          // markup, so `style-src 'self'` is satisfied without 'unsafe-inline'.
          bar.style.setProperty('--progress', String(ratio));
        }
        meter.toggleAttribute('data-complete', answered >= total);
      };

      /**
       * Announce separately from painting. The text node is the live region, so
       * writing it is what triggers the announcement; arrowing across nine scale
       * options would otherwise queue nine of them.
       */
      const announce = debounce((answered) => {
        if (!text) return;
        const next = template
          .replaceAll('{answered}', String(answered))
          .replaceAll('{total}', String(total));
        if (text.textContent !== next) text.textContent = next;
      }, 250);

      const update = () => {
        const answered = countAnswered();
        render(answered);
        announce(answered);
      };

      // Mark the meter enhanced. The stylesheet keeps the decorative track
      // hidden until this happens, because without JavaScript there is no way
      // to set a fill width and a bar frozen at zero beside correct text would
      // be worse than no bar at all.
      meter.setAttribute('data-enhanced', '');

      // Delegated, so radios added by a future "add another taco" control are
      // picked up with no rebinding.
      scope.addEventListener('change', (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.type === 'radio') update();
      });

      // Restored form state after a back navigation or a failed submit.
      const initial = countAnswered();
      render(initial);
      if (text && initial > 0) {
        const next = template
          .replaceAll('{answered}', String(initial))
          .replaceAll('{total}', String(total));
        // Written directly rather than through announce(), so reloading a
        // half-filled form does not fire an announcement nobody asked for.
        if (text.textContent !== next) text.textContent = next;
      }
    }
  };

  /* ======================================================================
     4. Error summary focus management
     ====================================================================== */

  const initErrorSummary = () => {
    const summary = document.querySelector('[data-error-summary]');

    if (summary instanceof HTMLElement) {
      // tabindex="-1" comes from the markup; this is a safety net for a
      // renderer that forgets it, since focus() on an element without it is a
      // silent no-op.
      if (!summary.hasAttribute('tabindex')) summary.setAttribute('tabindex', '-1');

      // After paint, so the browser has finished any fragment scroll of its own
      // and does not fight this one.
      requestAnimationFrame(() => {
        try {
          summary.focus();
        } catch {
          /* not focusable for some reason; the alert role still announces it */
        }
      });
    }

    // A fragment link scrolls the target into view but does not reliably focus
    // it, which leaves a keyboard user's next Tab starting from the summary
    // rather than from the field they just asked to be taken to.
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const link = target.closest('a[href^="#"]');
      if (!(link instanceof HTMLAnchorElement)) return;
      if (!link.closest('[data-error-summary], .error-summary')) return;

      const id = link.getAttribute('href')?.slice(1);
      if (!id) return;

      const destination = document.getElementById(id);
      if (!destination) return;

      // A scale is a fieldset: focus its checked option, or its first one, so
      // arrow keys work immediately on arrival.
      const focusTarget =
        destination instanceof HTMLFieldSetElement
          ? destination.querySelector('input:checked') ??
            destination.querySelector('input, select, textarea, button')
          : destination;

      if (focusTarget instanceof HTMLElement) {
        // Let the browser do the scrolling from the fragment, then take focus.
        requestAnimationFrame(() => {
          try {
            focusTarget.focus({ preventScroll: true });
          } catch {
            /* nothing to do */
          }
        });
      }
    });
  };

  /* ======================================================================
     Show-password toggles

     NIST asks verifiers to offer a reveal option, because silently mistyping a
     long passphrase twice is a worse outcome than briefly showing it.
     ====================================================================== */

  const initPasswordToggles = () => {
    const toggles = all(document, '[data-password-toggle]');
    if (toggles.length === 0) return;

    /** @param {HTMLElement} button */
    const sync = (button) => {
      const input = document.getElementById(
        button.getAttribute('data-password-toggle') ?? '',
      );
      if (!(input instanceof HTMLInputElement)) return;

      const revealed = input.type === 'text';
      button.setAttribute('aria-pressed', revealed ? 'true' : 'false');
      // The label states the ACTION, while aria-pressed states the STATE.
      // Screen reader users get both without the two contradicting each other.
      button.textContent = revealed ? 'Hide password' : 'Show password';
    };

    for (const button of toggles) sync(/** @type {HTMLElement} */ (button));

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('[data-password-toggle]');
      if (!button) return;

      const input = document.getElementById(
        button.getAttribute('data-password-toggle') ?? '',
      );
      if (!(input instanceof HTMLInputElement)) return;

      // Preserve the caret so revealing mid-typing does not send the cursor to
      // the end of a half-entered passphrase.
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.type = input.type === 'password' ? 'text' : 'password';
      try {
        if (start !== null && end !== null) input.setSelectionRange(start, end);
      } catch {
        // setSelectionRange throws on some input types; not worth failing over.
      }
      input.focus();
      sync(/** @type {HTMLElement} */ (button));
    });

    // Never leave a password visible on a page that is being left or hidden.
    const concealAll = () => {
      for (const button of toggles) {
        const input = document.getElementById(
          button.getAttribute('data-password-toggle') ?? '',
        );
        if (input instanceof HTMLInputElement && input.type === 'text') {
          input.type = 'password';
          sync(/** @type {HTMLElement} */ (button));
        }
      }
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') concealAll();
    });
    for (const form of all(document, 'form')) {
      form.addEventListener('submit', concealAll);
    }
  };

  /* ======================================================================
     Live rubric anchor text

     The rubric documents what specific levels mean (1, 3 and 5 for the taste
     metrics; all five for the observer variables). Hiding that behind a
     disclosure means nobody reads it, which defeats the point of an anchored
     rubric: the anchors are what make scores repeatable between visits.

     So once JavaScript is available, the disclosure is replaced by the meaning
     of whatever level is currently selected. With JavaScript blocked the
     <details> stays exactly as the server rendered it.
     ====================================================================== */

  const initScaleMeanings = () => {
    const scales = all(document, '.scale[data-anchors]');
    if (scales.length === 0) return;

    for (const scale of scales) {
      /** @type {Record<string, string>} */
      let anchors;
      try {
        anchors = JSON.parse(scale.getAttribute('data-anchors') ?? '{}');
      } catch {
        continue; // Leave the <details> fallback in place for this one.
      }

      const levels = Object.keys(anchors)
        .map(Number)
        .filter((level) => Number.isFinite(level))
        .sort((a, b) => a - b);
      if (levels.length === 0) continue;

      const meaning = scale.querySelector('[data-scale-meaning]');
      const details = scale.querySelector('.scale__anchors');
      if (!(meaning instanceof HTMLElement)) continue;

      // Only now is the disclosure redundant, so only now is it removed.
      if (details instanceof HTMLElement) details.hidden = true;
      meaning.hidden = false;

      /** @param {number} value */
      const describe = (value) => {
        const exact = anchors[String(value)];
        if (exact) {
          return { level: String(value), text: exact, between: false };
        }
        // Undocumented levels are the norm on a 1 to 5 scale anchored only at
        // 1, 3 and 5, and half steps make it more so. Naming the two anchors it
        // sits between is what the rubric itself tells the scorer to do.
        const below = [...levels].reverse().find((l) => l < value);
        const above = levels.find((l) => l > value);
        if (below !== undefined && above !== undefined) {
          return {
            level: String(value),
            text: `Between ${below} (${anchors[String(below)]}) and ${above} (${anchors[String(above)]})`,
            between: true,
          };
        }
        return null;
      };

      const render = () => {
        const checked = scale.querySelector('.scale__input:checked');
        if (!(checked instanceof HTMLInputElement)) {
          meaning.textContent = 'Choose a rating to see what it means.';
          meaning.classList.add('scale__meaning--empty');
          return;
        }
        const described = describe(Number(checked.value));
        if (!described) {
          meaning.textContent = '';
          meaning.classList.add('scale__meaning--empty');
          return;
        }
        meaning.classList.remove('scale__meaning--empty');
        meaning.textContent = '';

        const number = document.createElement('span');
        number.className = 'scale__meaning-level';
        number.textContent = described.level;

        const text = document.createElement('span');
        text.className = 'scale__meaning-text';
        text.textContent = described.text;

        // Built as nodes rather than innerHTML: the anchor strings come from the
        // rubric, but building DOM keeps this immune to that ever changing.
        meaning.append(number, text);
      };

      scale.addEventListener('change', render);
      render();
    }
  };

  /* ======================================================================
     Boot
     ====================================================================== */

  const boot = () => {
    feature('theme toggle', initTheme);
    feature('photo field', initPhotoFields);
    feature('progress meter', initProgressMeters);
    feature('error summary', initErrorSummary);
    feature('password toggles', initPasswordToggles);
    feature('scale meanings', initScaleMeanings);
  };

  // `defer` guarantees the document is parsed, but the readyState check keeps
  // this correct if the file is ever loaded some other way.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
