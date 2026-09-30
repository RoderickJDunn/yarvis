import { describe, expect, it } from "bun:test";
import { describeResult, MAX_RESULT_CHARS, TOOL_FOR_COMMAND } from "../../extension/activity.js";

describe("describeResult", () => {
  it("keeps a whole result as readable JSON", () => {
    expect(describeResult({ ok: true, data: { url: "https://a" } })).toEqual({
      result: '{\n  "url": "https://a"\n}',
      resultTruncated: false,
    });
  });

  it("shows the error for a failed command", () => {
    expect(describeResult({ ok: false, error: "That link leaves this site." }).result).toBe(
      "That link leaves this site.",
    );
  });

  it("cuts a result too large for session storage and says so", () => {
    const out = describeResult({ ok: true, data: "x".repeat(MAX_RESULT_CHARS * 2) });
    expect(out.result).toHaveLength(MAX_RESULT_CHARS);
    expect(out.resultTruncated).toBe(true);
  });
});

describe("TOOL_FOR_COMMAND", () => {
  it("names the tool behind every command the extension answers", () => {
    expect(Object.keys(TOOL_FOR_COMMAND).sort()).toEqual(
      ["click", "list_elements", "list_tabs", "navigate", "read_page", "scroll"].sort(),
    );
  });
});
