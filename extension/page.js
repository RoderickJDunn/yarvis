// The half of the extension that runs inside the page.
//
// background.js injects this file (after any site adapters, see adapters/) into
// the tab's isolated world before each command, then calls one of the functions
// on globalThis.__yarvis. The isolated world is shared with nothing on the page,
// so the page can't see or call these, and the element refs kept here survive
// between commands for as long as the document does.
//
// Every way of choosing something to click — a ref from a listing, a ref from
// inspect, a CSS selector the agent wrote — ends in the same screens in
// clickTarget(): same site only, no controls that send or change things, no form
// submits. None of it types, and no keyboard or input event is ever sent.

(() => {
  const CLICKABLE =
    'a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="treeitem"],[role="menuitem"],[role="option"]';

  /** Longest label kept per element in a listing. */
  const LABEL_CHARS = 120;

  /**
   * A chosen element that isn't a control is only clicked if its own text is
   * about this long or less. Anything bigger is a container — a message pane, a
   * whole sidebar — and a click in its middle lands on whatever is there.
   */
  const MAX_PLAIN_LABEL = 200;

  // Refs outlive re-injection: they sit on window rather than in this closure.
  if (!(window.__yarvisRefs?.byRef instanceof Map)) {
    window.__yarvisRefs = { byRef: new Map(), scrollRefs: new Set(), next: 1 };
  }
  const state = window.__yarvisRefs;

  function resetRefs() {
    state.byRef = new Map();
    state.scrollRefs = new Set();
    state.next = 1;
  }

  function remember(el, { scroll = false } = {}) {
    for (const [ref, known] of state.byRef) if (known === el) return ref;
    const ref = state.next++;
    state.byRef.set(ref, el);
    if (scroll) state.scrollRefs.add(ref);
    return ref;
  }

  function adapter() {
    return Object.values(globalThis.__yarvisAdapters ?? {}).find((a) => a.matches(location));
  }

  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const labelOf = (el) => clean(el.getAttribute("aria-label") || el.innerText || el.title || "");

  function visible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /** A same-site link to a page moves around rather than acting; null otherwise. */
  function sameSiteLink(el) {
    if (el.tagName !== "A") return null;
    const raw = el.getAttribute("href");
    if (!raw || raw.startsWith("#")) return null;
    try {
      const url = new URL(el.href);
      return url.origin === location.origin ? url : null;
    } catch {
      return null;
    }
  }

  const isSubmit = (el) =>
    (el.tagName === "INPUT" && el.type === "submit") ||
    (el.tagName === "BUTTON" && el.form && el.type === "submit");

  /**
   * Why an element may not be offered or clicked, or null if it may. A same-site
   * link is judged by its address, so a channel called "post-mortems" opens but
   * a link to /logout doesn't; anything else is judged by its label.
   */
  function refusal(el, rules, { needsLabel = true } = {}) {
    if (el.disabled) return "That control is disabled.";
    if (isSubmit(el)) return "That control submits a form, so Yarvis won't click it.";
    const link = sameSiteLink(el);
    if (link) {
      return rules.blockedPath.test(link.pathname + link.search)
        ? "That link changes something on the site, so Yarvis won't open it."
        : null;
    }
    const label = labelOf(el);
    if (!label && needsLabel) {
      return "Something without a label would take that click, so Yarvis won't click it.";
    }
    return rules.blocked.test(label)
      ? "That control changes or sends something, so Yarvis won't click it."
      : null;
  }

  function rulesFrom({ blockedSource, blockedPathSource }) {
    return {
      blocked: new RegExp(blockedSource, "i"),
      blockedPath: new RegExp(blockedPathSource, "i"),
    };
  }

  /** querySelectorAll that reports a bad selector as an error the agent can fix. */
  function select(selector, root = document) {
    try {
      return { nodes: [...root.querySelectorAll(selector)] };
    } catch (error) {
      return { error: `That selector isn't valid CSS: ${error.message}` };
    }
  }

  function readPage({ maxChars }) {
    const base = {
      url: location.href,
      title: document.title,
      selection: String(getSelection() ?? ""),
    };
    const site = adapter();
    let adapterNote;
    if (site?.readPage) {
      try {
        const read = site.readPage();
        if (read) {
          return {
            ...base,
            adapter: site.name,
            text: read.text.slice(0, maxChars),
            truncated: read.text.length > maxChars,
          };
        }
        adapterNote = `The ${site.name} reader found nothing it recognises here, so this is the plain page text.`;
      } catch (error) {
        adapterNote = `The ${site.name} reader failed (${error.message}), so this is the plain page text.`;
      }
    }
    const text = document.body?.innerText ?? "";
    return {
      ...base,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      ...(adapterNote ? { adapterNote } : {}),
    };
  }

  function describe(el, label) {
    const site = adapter();
    let extra = {};
    try {
      extra = site?.describeElement?.(el) ?? {};
    } catch {
      // An adapter that trips over one element shouldn't lose the listing.
    }
    return {
      kind: el.tagName === "A" ? "link" : el.getAttribute("role") || "button",
      label,
      ...(el.tagName === "A" ? { href: el.href } : {}),
      ...extra,
    };
  }

  /**
   * Numbers each thing worth clicking and remembers the element, so a later click
   * names a number instead of a selector the page could have changed under us.
   * A custom selector lists what it matches instead of the usual controls, under
   * the same screens; `text` keeps only labels containing it.
   */
  function listElements({ maxElements, selector, text, ...rules }) {
    const screens = rulesFrom(rules);
    resetRefs();
    const found = select(selector || CLICKABLE);
    if (found.error) return { error: found.error };
    const wanted = text ? text.toLowerCase() : null;

    const elements = [];
    let truncated = false;
    let skipped = 0;
    for (const el of found.nodes) {
      if (!visible(el)) continue;
      const label = labelOf(el).slice(0, LABEL_CHARS);
      if (wanted && !label.toLowerCase().includes(wanted)) continue;
      if (refusal(el, screens)) {
        skipped++;
        continue;
      }
      if (elements.length >= maxElements) {
        truncated = true;
        break;
      }
      elements.push({ ref: remember(el), ...describe(el, label) });
    }

    // Message lists and side panels scroll on their own, not with the window.
    if (!selector && !text) {
      let scrollers = 0;
      for (const el of document.querySelectorAll("div,main,section,ul,ol")) {
        if (scrollers >= 10) break;
        if (el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 50) continue;
        const overflow = getComputedStyle(el).overflowY;
        if (overflow !== "auto" && overflow !== "scroll") continue;
        scrollers++;
        elements.push({
          ref: remember(el, { scroll: true }),
          kind: "scroll",
          label: (el.getAttribute("aria-label") || el.getAttribute("role") || el.tagName).slice(
            0,
            LABEL_CHARS,
          ),
        });
      }
    }

    const site = adapter();
    return {
      url: location.href,
      title: document.title,
      ...(site ? { adapter: site.name } : {}),
      elements,
      truncated,
      ...(skipped ? { skipped } : {}),
    };
  }

  /** Attributes worth showing when working out how a page is built. No values that carry data (value, src, content). */
  function attributesOf(el) {
    const out = {};
    for (const { name, value } of el.attributes) {
      const keep =
        name === "id" ||
        name === "class" ||
        name === "role" ||
        name === "type" ||
        name === "name" ||
        name === "title" ||
        name === "tabindex" ||
        name === "href" ||
        name.startsWith("aria-") ||
        name.startsWith("data-");
      if (!keep) continue;
      // Query strings and fragments carry tokens; the path is enough to tell links apart.
      const shown = name === "href" ? value.replace(/[?#].*$/, "") : value;
      out[name] = shown.slice(0, 200);
    }
    return out;
  }

  /**
   * What a selector matches, for an agent working out why a listing or click
   * didn't do what it expected. Each match gets a ref it can click or scroll.
   */
  function inspect({ selector, limit, ...rules }) {
    const screens = rulesFrom(rules);
    const found = select(selector);
    if (found.error) return { error: found.error };
    const matches = found.nodes.slice(0, limit).map((el) => {
      const rect = el.getBoundingClientRect();
      const control = el.closest(CLICKABLE);
      const why = refusal(control ?? el, screens, { needsLabel: false });
      return {
        ref: remember(el),
        tag: el.tagName.toLowerCase(),
        attributes: attributesOf(el),
        text: clean(el.innerText).slice(0, 200),
        visible: visible(el),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        clickable: Boolean(control),
        ...(why ? { refused: why } : {}),
        children: [...el.children].slice(0, 10).map((child) => {
          const role = child.getAttribute("role");
          const qa = child.getAttribute("data-qa");
          return [child.tagName.toLowerCase(), role && `[role=${role}]`, qa && `[data-qa=${qa}]`]
            .filter(Boolean)
            .join("");
        }),
        childCount: el.children.length,
      };
    });
    return {
      url: location.href,
      title: document.title,
      count: found.nodes.length,
      matches,
    };
  }

  function resolve({ ref, selector, index = 0 }) {
    if (ref !== undefined && ref !== null) {
      const el = state.byRef.get(ref);
      if (!el || !el.isConnected) {
        return { error: "That element is gone. List the page's elements again." };
      }
      return { el, fromScrollRef: state.scrollRefs.has(ref) };
    }
    const found = select(selector);
    if (found.error) return { error: found.error };
    if (found.nodes.length === 0) return { error: `Nothing on the page matches ${selector}.` };
    const el = found.nodes[index];
    if (!el) {
      return {
        error: `${selector} matches ${found.nodes.length} elements; index ${index} is past the end.`,
      };
    }
    return { el, fromScrollRef: false };
  }

  /**
   * Screens and clicks. `center` clicks the element under the middle of the chosen
   * one, which is where a person's click lands: apps like Slack put the handler
   * on something inside a sidebar row, and an event sent to the row itself only
   * bubbles up, never down to it. `direct` sends the events to the chosen element
   * itself, for when something else covers its middle. `hover` only moves the
   * pointer over it, to show menus and buttons that appear on hover.
   */
  function click({ ref, selector, index, mode = "center", ...rules }) {
    const screens = rulesFrom(rules);
    const chosen = resolve({ ref, selector, index });
    if (chosen.error) return chosen;
    const { el } = chosen;
    if (chosen.fromScrollRef) {
      return {
        error: "That ref is a scrollable panel, not something to click. Use scroll_browser_page.",
      };
    }

    const ownControl = el.closest(CLICKABLE);
    if (!ownControl && labelOf(el).length > MAX_PLAIN_LABEL) {
      return {
        error:
          "That element holds too much to click safely (it looks like a container). Inspect it and pick something smaller inside it.",
      };
    }

    el.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    let target = el;
    if (mode === "center") {
      const hit = document.elementFromPoint(x, y);
      // Something covering that point (a toast, a modal) doesn't get the click.
      if (hit && el.contains(hit)) target = hit;
    }

    // Everything the click can reach is screened: the chosen element, the control
    // it sits in, and a control nested in it where the click really lands — an
    // icon-only delete button in a row is refused rather than trusted.
    const hitControl = target.closest(CLICKABLE);
    const nested = hitControl && hitControl !== el && el.contains(hitControl) ? hitControl : null;
    const checks = [
      el,
      ...(ownControl && ownControl !== el ? [ownControl] : []),
      ...(nested ? [nested] : []),
    ];
    for (const node of checks) {
      const why = refusal(node, screens);
      if (why) return { error: why };
    }

    const anchor = target.closest("a[href]");
    if (anchor) {
      let url;
      try {
        url = new URL(anchor.href);
      } catch {
        return { error: "That link has no usable address." };
      }
      if (url.origin !== location.origin) {
        return { error: "That link leaves this site. Yarvis stays on the current site." };
      }
      if (anchor.target && anchor.target !== "_self") {
        return { error: "That link opens a new tab. Yarvis works in the current tab only." };
      }
    }

    const base = {
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      view: window,
    };
    const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    const fire = (type, init) => {
      const Kind = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      const event = new Kind(type, { ...base, ...pointer, bubbles: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    fire("pointerover", { buttons: 0 });
    fire("pointerenter", { buttons: 0, bubbles: false });
    fire("mouseover", { buttons: 0 });
    fire("mouseenter", { buttons: 0, bubbles: false });
    fire("pointermove", { buttons: 0 });
    fire("mousemove", { buttons: 0 });
    const clicked = {
      tag: target.tagName.toLowerCase(),
      label: labelOf(target).slice(0, LABEL_CHARS),
    };
    // A hover leaves the pointer where it is, so whatever it revealed stays up.
    if (mode === "hover") return { ok: true, clicked };

    // The sequence a real mouse click produces; some apps act on pointerdown or
    // mousedown and never look at the click.
    fire("pointerdown", { buttons: 1, detail: 1 });
    const down = fire("mousedown", { buttons: 1, detail: 1 });
    // The browser focuses the nearest focusable element unless mousedown was cancelled.
    const focusable = target.closest("a[href],button,[tabindex],summary,input,select,textarea");
    if (!down.defaultPrevented && focusable) focusable.focus({ preventScroll: true });
    fire("pointerup", { buttons: 0, detail: 1 });
    fire("mouseup", { buttons: 0, detail: 1 });
    fire("click", { buttons: 0, detail: 1 });
    // Moved off afterwards, so no hover state is left to reveal buttons on the row.
    fire("pointerout", { buttons: 0 });
    fire("pointerleave", { buttons: 0, bubbles: false });
    fire("mouseout", { buttons: 0 });
    fire("mouseleave", { buttons: 0, bubbles: false });
    return { ok: true, clicked };
  }

  function scroll({ ref, direction }) {
    const el =
      ref === null || ref === undefined
        ? document.scrollingElement || document.documentElement
        : state.byRef.get(ref);
    if (!el || !el.isConnected) {
      return { error: "That element is gone. List the page's elements again." };
    }
    const step = el.clientHeight * 0.8;
    if (direction === "up") el.scrollBy({ top: -step });
    else if (direction === "down") el.scrollBy({ top: step });
    else if (direction === "top") el.scrollTop = 0;
    else if (direction === "bottom") el.scrollTop = el.scrollHeight;
    // Any other direction ("stay") only reports where the panel is.
    return {
      atTop: el.scrollTop <= 0,
      atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
    };
  }

  globalThis.__yarvis = { readPage, listElements, inspect, click, scroll };
})();
