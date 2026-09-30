// Slack adapter: the same browser tools, with Slack-shaped results.
//
// read_browser_page returns the loaded messages as a transcript instead of the
// whole page's text (sidebar, toolbar and composer included), and
// list_browser_elements tags sidebar conversations with their channel id and an
// address that opens them. Nothing here changes what may be clicked; page.js
// screens every click the same way on every site.
//
// Slack's markup is not a public interface, so each part is looked for under a
// few selectors, and anything not found leaves page.js to fall back to the
// generic behaviour and say so.

(() => {
  const MESSAGE = ['[data-qa="message_container"]', ".c-message_kit__message"];
  const SENDER = [
    '[data-qa="message_sender_name"]',
    ".c-message__sender_button",
    '[data-qa="message_sender"]',
  ];
  const TIMESTAMP = ["a.c-timestamp", '[data-qa="timestamp_label"]', "a[data-ts]"];
  const BODY = ['[data-qa="message-text"]', ".c-message_kit__blocks", ".p-rich_text_block"];
  const REPLIES = ['[data-qa="reply_bar_count"]', ".c-message__reply_count"];
  const HEADER = ['[data-qa="channel_name"]', ".p-view_header__channel_title"];

  /** Slack conversation ids: C channels, D direct messages, G group DMs. */
  const CONVERSATION_ID = /^[CDG][A-Z0-9]{6,}$/;
  const ID_IN_ADDRESS = /\/(?:archives|client\/T[A-Z0-9]+)\/([CDG][A-Z0-9]{6,})/;

  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const text = (el) => clean(el?.innerText ?? el?.textContent);

  function first(root, selectors) {
    for (const selector of selectors) {
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function all(root, selectors) {
    for (const selector of selectors) {
      const found = root.querySelectorAll(selector);
      if (found.length > 0) return [...found];
    }
    return [];
  }

  function conversationName() {
    const header = text(first(document, HEADER));
    if (header) return header;
    // "general (Channel) - Acme - Slack": the first part names the conversation.
    return clean(document.title.split(" - ")[0]);
  }

  /** The message's time as Slack shows it, e.g. "Today at 12:40:24 PM". */
  function timeOf(message) {
    const stamp = first(message, TIMESTAMP);
    return clean(stamp?.getAttribute("aria-label") || text(stamp));
  }

  /**
   * The loaded messages as "[time] author: text" lines, oldest first, or null
   * when none are found. Slack leaves the sender off a run of messages from the
   * same person, so the last one seen carries over.
   */
  function readPage() {
    const messages = all(document, MESSAGE);
    if (messages.length === 0) return null;
    const lines = [];
    let author = "";
    for (const message of messages) {
      author = text(first(message, SENDER)) || author;
      const body = text(first(message, BODY));
      if (!body) continue;
      const replies = text(first(message, REPLIES));
      const time = timeOf(message);
      lines.push(
        `${time ? `[${time}] ` : ""}${author || "(unknown)"}: ${body}${replies ? ` (${replies})` : ""}`,
      );
    }
    if (lines.length === 0) return null;
    const header = [
      `Conversation: ${conversationName()}`,
      "Only the messages Slack has loaded are here; scroll the message list up for older ones.",
      "",
    ];
    return { text: [...header, ...lines].join("\n") };
  }

  /** The conversation a sidebar row opens, from an attribute on it or a link inside it. */
  function conversationIdOf(el) {
    const tagged =
      el.closest("[data-qa-channel-sidebar-channel-id]") ??
      el.querySelector("[data-qa-channel-sidebar-channel-id]");
    const fromAttribute = tagged?.getAttribute("data-qa-channel-sidebar-channel-id");
    if (fromAttribute && CONVERSATION_ID.test(fromAttribute)) return fromAttribute;
    for (const link of [el.closest("a[href]"), ...el.querySelectorAll("a[href]")]) {
      const match = link?.getAttribute("href")?.match(ID_IN_ADDRESS);
      if (match) return match[1];
    }
    return null;
  }

  function describeElement(el, loc = location) {
    const id = conversationIdOf(el);
    if (!id) return null;
    const team = loc.pathname.match(/^\/client\/(T[A-Z0-9]+)/)?.[1];
    return {
      channelId: id,
      // Loading this opens the conversation even when its sidebar row isn't rendered.
      ...(team ? { openUrl: `${loc.origin}/client/${team}/${id}` } : {}),
    };
  }

  const matches = (loc) => loc.hostname === "app.slack.com" || loc.hostname.endsWith(".slack.com");

  globalThis.__yarvisAdapters ??= {};
  globalThis.__yarvisAdapters.slack = { name: "slack", matches, readPage, describeElement };
})();
