// A log of what Yarvis asked this browser to do, for the side panel.
//
// It lives in session storage: kept in memory while Chrome runs, never written
// to disk, and gone when the browser quits. Page text is in here, and it should
// not outlive the session any more than the tab does.

export const ACTIVITY_KEY = "activity";
const MAX_ENTRIES = 50;

/** Per entry, so fifty full page reads stay well inside session storage's 10 MB. */
export const MAX_RESULT_CHARS = 100_000;

/** The tool the agent called, for each command the extension answers. */
export const TOOL_FOR_COMMAND = {
  list_tabs: "list_browser_tabs",
  read_page: "read_browser_page",
  list_elements: "list_browser_elements",
  click: "click_browser_element",
  scroll: "scroll_browser_page",
  navigate: "navigate_browser_tab",
};

/** The result as the panel shows it: pretty JSON, cut to a size storage can hold. */
export function describeResult(reply) {
  const body = reply.ok ? (JSON.stringify(reply.data, null, 2) ?? "") : (reply.error ?? "");
  if (body.length <= MAX_RESULT_CHARS) return { result: body, resultTruncated: false };
  return { result: body.slice(0, MAX_RESULT_CHARS), resultTruncated: true };
}

// Writes are chained so two commands finishing together can't drop each other's entry.
let writing = Promise.resolve();

export function recordActivity({ id, at, durationMs, instance, command, ok, data, error }) {
  const { type, ...args } = command ?? {};
  const entry = {
    id,
    at,
    durationMs,
    instance: instance ?? "",
    tool: TOOL_FOR_COMMAND[type] ?? String(type),
    args,
    ok,
    ...describeResult({ ok, data, error }),
  };
  writing = writing
    .then(async () => {
      const stored = (await chrome.storage.session.get(ACTIVITY_KEY))[ACTIVITY_KEY] ?? [];
      await chrome.storage.session.set({
        [ACTIVITY_KEY]: [entry, ...stored].slice(0, MAX_ENTRIES),
      });
    })
    .catch(() => {
      // Losing a log line must never fail the command it describes.
    });
  return writing;
}

export function clearActivity() {
  return chrome.storage.session.set({ [ACTIVITY_KEY]: [] });
}
