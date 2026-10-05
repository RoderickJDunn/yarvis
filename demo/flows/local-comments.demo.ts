import { expect, test } from "../fixture";

test("local comments", async ({ demo, page }) => {
  await demo.openTab("Workspaces");
  await demo.click(page.getByText("Payment step", { exact: true }));
  await expect(page.getByText("Welcome to Claude Code!")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("3 changed files")).toBeVisible();
  await demo.shot("changed files");

  const lineWith = (text: string) =>
    page.locator('div[class*="group/line"]').filter({ hasText: text }).first();

  /** Opens a changed file's diff and leaves a comment on the line holding `code`. */
  async function comment(path: string, code: string, body: string) {
    await demo.click(page.getByTitle(`Open diff for ${path}`));
    const line = lineWith(code);
    await expect(line).toBeVisible();
    await demo.hover(line);
    await demo.click(line.getByRole("button", { name: "Comment on this line" }));
    await demo.type(page.getByPlaceholder("Note for yourself (or for Claude)…"), body);
    await demo.click(page.getByRole("button", { name: "Save comment" }));
    await expect(page.getByText(body)).toBeVisible();
    // Onto the diff's header, so no row is left showing its "+" button.
    await demo.hover(page.getByText(path, { exact: true }));
  }

  await comment(
    "src/checkout/PaymentStep.tsx",
    "const CardForm = lazy",
    "Customers with no saved cards now wait on this import. Prefetch it when the list comes back empty.",
  );
  await demo.shot("comment on the diff");

  await comment(
    "src/checkout/usePaymentIntent.ts",
    "retry: 3,",
    "Retry once, not three times, so a declined card doesn't hit the processor four times.",
  );

  await demo.click(page.getByRole("button", { name: /^Comments/ }));
  await expect(page.getByText("2 open")).toBeVisible();
  await demo.shot("comments list");

  await demo.click(page.getByRole("button", { name: "Copy for Claude" }));
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  // By title: the tab's accessible name also takes in its status dot.
  await demo.click(page.getByTitle("Claude", { exact: true }));
  const agent = page.locator(".xterm").filter({ visible: true }).first();
  await demo.paste(agent);
  await expect(page.getByText("[Pasted text #1")).toBeVisible();
  await demo.shot("pasted into claude");

  await demo.press("Enter");
  // Short phrases, so a narrower pane wrapping the line doesn't split them.
  await expect(page.getByText("Both comments are addressed.")).toBeVisible({ timeout: 20_000 });
  await demo.shot("claude addressed the comments");
});
