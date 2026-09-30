import { ACTIVITY_KEY, clearActivity } from "./activity.js";

const list = document.getElementById("entries");
const empty = document.getElementById("empty");

/** Rows the user has opened, so a new entry arriving doesn't fold them back up. */
const open = new Set();

function block(label, text) {
  const heading = document.createElement("h3");
  heading.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = text;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => navigator.clipboard.writeText(text));
  return [heading, pre, copy];
}

function render(entries) {
  list.replaceChildren();
  empty.hidden = entries.length > 0;
  for (const entry of entries) {
    const item = document.createElement("li");
    const details = document.createElement("details");
    details.open = open.has(entry.id);
    details.addEventListener("toggle", () => {
      if (details.open) open.add(entry.id);
      else open.delete(entry.id);
    });

    const summary = document.createElement("summary");
    const dot = document.createElement("span");
    dot.className = entry.ok ? "dot on" : "dot error";
    dot.title = entry.ok ? "Answered" : "Failed";
    const tool = document.createElement("span");
    tool.className = "tool";
    tool.textContent = entry.tool;
    const meta = document.createElement("span");
    meta.className = "meta";
    const time = new Date(entry.at).toLocaleTimeString();
    meta.textContent = [entry.instance, time, `${entry.durationMs} ms`].filter(Boolean).join(" · ");
    summary.append(dot, tool, meta);

    const result = entry.resultTruncated
      ? `${entry.result}\n… cut here: the panel keeps the first 100,000 characters.`
      : entry.result;
    details.append(
      summary,
      ...block("Arguments", JSON.stringify(entry.args, null, 2)),
      ...block(entry.ok ? "Result" : "Error", result),
    );
    item.append(details);
    list.append(item);
  }
}

document.getElementById("clear").addEventListener("click", () => {
  open.clear();
  clearActivity();
});

chrome.storage.session.get(ACTIVITY_KEY).then((stored) => render(stored[ACTIVITY_KEY] ?? []));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[ACTIVITY_KEY]) render(changes[ACTIVITY_KEY].newValue ?? []);
});
