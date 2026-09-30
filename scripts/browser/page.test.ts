import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BLOCKED_LABEL_SOURCE, BLOCKED_PATH_SOURCE } from "../../extension/site.js";

/**
 * The in-page half of the extension (extension/page.js and the Slack adapter)
 * against happy-dom. happy-dom does no layout, so every element is given a size
 * and the point a click lands on is chosen per test.
 */

interface Page {
  readPage(options: { maxChars: number }): Record<string, unknown>;
  listElements(options: Record<string, unknown>): {
    error?: string;
    adapter?: string;
    elements: Array<Record<string, unknown>>;
    skipped?: number;
  };
  inspect(options: Record<string, unknown>): {
    error?: string;
    count: number;
    matches: Array<Record<string, unknown>>;
  };
  click(options: Record<string, unknown>): {
    ok?: boolean;
    error?: string;
    clicked?: { tag: string; label: string };
  };
}

const screens = { blockedSource: BLOCKED_LABEL_SOURCE, blockedPathSource: BLOCKED_PATH_SOURCE };
const page = () => (globalThis as unknown as { __yarvis: Page }).__yarvis;
const happy = () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

const originalRect = Element.prototype.getBoundingClientRect;
const originalFromPoint = document.elementFromPoint;

beforeAll(async () => {
  await import("../../extension/adapters/slack.js");
  await import("../../extension/page.js");
});

beforeEach(() => {
  happy().setURL("https://app.slack.com/client/T111/C999");
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20 }) as DOMRect;
  document.elementFromPoint = () => null;
  document.title = "general (Channel) - Acme - Slack";
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  document.elementFromPoint = originalFromPoint;
  document.body.innerHTML = "";
  happy().setURL("about:blank");
});

/** Records which events reach an element, to tell a click from a hover. */
function listen(el: Element): string[] {
  const seen: string[] = [];
  for (const type of ["pointerdown", "mousedown", "click", "mouseover"]) {
    el.addEventListener(type, () => seen.push(type));
  }
  return seen;
}

describe("click", () => {
  it("clicks the element under the middle of a row, where the handler is", () => {
    document.body.innerHTML = `
      <div role="treeitem" id="row"><a id="link" href="/client/T111/C222"><span id="name">agentic-intake</span></a></div>`;
    const name = document.getElementById("name") as HTMLElement;
    document.elementFromPoint = () => name;
    const seen = listen(document.getElementById("link") as Element);

    const out = page().click({ selector: "#row", ...screens });

    expect(out.error).toBeUndefined();
    expect(out.clicked).toEqual({ tag: "span", label: "agentic-intake" });
    expect(seen).toEqual(["mouseover", "pointerdown", "mousedown", "click"]);
  });

  it("refuses an unlabelled icon button that would take the click", () => {
    document.body.innerHTML = `<div role="treeitem" id="row">general<button id="trash"></button></div>`;
    const trash = document.getElementById("trash") as HTMLElement;
    document.elementFromPoint = () => trash;
    const seen = listen(trash);

    expect(page().click({ selector: "#row", ...screens }).error).toContain("without a label");
    expect(seen).toEqual([]);
  });

  it("refuses a labelled button nested in a same-site link", () => {
    document.body.innerHTML = `
      <a id="row" href="/client/T111/C222">general<button id="leave" aria-label="Leave channel"></button></a>`;
    document.elementFromPoint = () => document.getElementById("leave");

    expect(page().click({ selector: "#row", ...screens }).error).toContain("changes or sends");
  });

  it("refuses a same-site link to a state-changing address", () => {
    document.body.innerHTML = `<a id="out" href="/logout">Your profile</a>`;
    expect(page().click({ selector: "#out", ...screens }).error).toContain("changes something");
  });

  it("refuses a link to another site", () => {
    document.body.innerHTML = `<a id="away" href="https://evil.example/">Docs</a>`;
    expect(page().click({ selector: "#away", ...screens }).error).toContain("leaves this site");
  });

  it("refuses a container too big to click safely", () => {
    document.body.innerHTML = `<div id="pane">${"message text ".repeat(40)}</div>`;
    expect(page().click({ selector: "#pane", ...screens }).error).toContain("container");
  });

  it("reports a bad selector and one that matches nothing", () => {
    expect(page().click({ selector: "[[", ...screens }).error).toContain("isn't valid CSS");
    expect(page().click({ selector: "#missing", ...screens }).error).toContain(
      "Nothing on the page",
    );
  });

  it("only hovers in hover mode", () => {
    document.body.innerHTML = `<div role="button" id="menu">More options</div>`;
    const seen = listen(document.getElementById("menu") as Element);

    expect(page().click({ selector: "#menu", mode: "hover", ...screens }).ok).toBe(true);
    expect(seen).toEqual(["mouseover"]);
  });

  it("sends the click to the chosen element itself in direct mode", () => {
    document.body.innerHTML = `<div role="treeitem" id="row"><span id="inner">random</span></div>`;
    document.elementFromPoint = () => document.getElementById("inner");

    expect(page().click({ selector: "#row", mode: "direct", ...screens }).clicked?.tag).toBe("div");
  });

  it("clicks by a ref from a listing", () => {
    document.body.innerHTML = `<button id="b">Threads</button>`;
    const listed = page().listElements({ maxElements: 50, ...screens });
    const ref = listed.elements.find((el) => el.label === "Threads")?.ref;
    expect(page().click({ ref, ...screens }).ok).toBe(true);
  });
});

describe("listElements", () => {
  it("leaves out controls that send or change things and says how many", () => {
    document.body.innerHTML = `<button>Threads</button><button>Send</button><button>Delete message</button>`;
    const out = page().listElements({ maxElements: 50, ...screens });
    expect(out.elements.map((el) => el.label)).toEqual(["Threads"]);
    expect(out.skipped).toBe(2);
  });

  it("filters by text and lists what a custom selector matches", () => {
    document.body.innerHTML = `
      <div data-qa="item" role="treeitem">agentic-intake</div>
      <div data-qa="item" role="treeitem">random</div>`;
    const byText = page().listElements({ maxElements: 50, text: "INTAKE", ...screens });
    expect(byText.elements.map((el) => el.label)).toEqual(["agentic-intake"]);

    const bySelector = page().listElements({
      maxElements: 50,
      selector: '[data-qa="item"]',
      ...screens,
    });
    expect(bySelector.elements).toHaveLength(2);
  });

  it("tags Slack conversations with their id and an address that opens them", () => {
    document.body.innerHTML = `
      <div role="treeitem"><div data-qa-channel-sidebar-channel-id="C0ABC1234">agentic-intake</div></div>`;
    const out = page().listElements({ maxElements: 50, ...screens });
    expect(out.adapter).toBe("slack");
    expect(out.elements[0]).toMatchObject({
      label: "agentic-intake",
      channelId: "C0ABC1234",
      openUrl: "https://app.slack.com/client/T111/C0ABC1234",
    });
  });
});

describe("inspect", () => {
  it("shows structure without values that carry data, and why a click would be refused", () => {
    document.body.innerHTML = `
      <div role="treeitem" data-qa="row" class="c-row">
        <input name="csrf" value="secret-token" type="hidden" />
        <a href="/logout?session=abc">Sign out</a>
      </div>`;
    const out = page().inspect({ selector: "a, input", limit: 10, ...screens });

    expect(out.count).toBe(2);
    const [input, link] = out.matches as [Record<string, unknown>, Record<string, unknown>];
    expect(JSON.stringify(input)).not.toContain("secret-token");
    expect((link.attributes as Record<string, string>).href).toBe("/logout");
    expect(link.refused).toContain("changes something");
  });
});

describe("Slack readPage", () => {
  it("returns the loaded messages as a transcript, carrying the sender over", () => {
    document.body.innerHTML = `
      <div data-qa="message_container">
        <span data-qa="message_sender_name">Christine</span>
        <a class="c-timestamp" aria-label="Today at 12:40:24 PM"></a>
        <div data-qa="message-text">Can you look at the intake flow?</div>
        <span data-qa="reply_bar_count">3 replies</span>
      </div>
      <div data-qa="message_container">
        <a class="c-timestamp" aria-label="Today at 12:40:29 PM"></a>
        <div data-qa="message-text">It's blocking the pilot.</div>
      </div>`;
    const out = page().readPage({ maxChars: 10_000 });

    expect(out.adapter).toBe("slack");
    expect(out.text).toContain("Conversation: general (Channel)");
    expect(out.text).toContain(
      "[Today at 12:40:24 PM] Christine: Can you look at the intake flow? (3 replies)",
    );
    expect(out.text).toContain("[Today at 12:40:29 PM] Christine: It's blocking the pilot.");
  });

  it("falls back to the page text and says so when it finds no messages", () => {
    document.body.innerHTML = `<main>Search results for "pilot"</main>`;
    const out = page().readPage({ maxChars: 10_000 });

    expect(out.adapter).toBeUndefined();
    expect(out.text).toContain("Search results");
    expect(out.adapterNote).toContain("slack reader found nothing");
  });

  it("isn't used off Slack", () => {
    happy().setURL("https://example.com/");
    document.body.innerHTML = `<div data-qa="message_container"><div data-qa="message-text">hi</div></div>`;
    const out = page().readPage({ maxChars: 10_000 });
    expect(out.adapter).toBeUndefined();
    expect(out.adapterNote).toBeUndefined();
  });
});
