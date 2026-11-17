import { expect, test, type Page } from "@playwright/test";
import { ACCESS_TOKEN_KEY, issueAccessToken, seedSignedInUser } from "./support/session";

// The API under test runs with NODE_ENV=test, which selects the scripted chat model (no OpenAI):
// it answers a fixed text in pieces, fails on "[fail]" and answers slowly on "[slow]".
const SCRIPTED_ANSWER = "This is a scripted answer from the test model.";
const NOTICE = "Informational support only. It does not replace a licensed professional.";

async function openHomeWithUser(page: Page, label: string) {
  const { user, token } = await seedSignedInUser(label, "Eva", "Lima");

  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [ACCESS_TOKEN_KEY, token],
  );
  await page.goto("/app");
  await expect(page.getByRole("combobox", { name: "Expert" })).toBeVisible();

  return { user, token };
}

async function openHome(page: Page, label: string) {
  await openHomeWithUser(page, label);
}

const textbox = (page: Page) => page.getByRole("textbox", { name: /^Message for the/ });

test.describe("Chat with the experts", () => {
  test("asks a suggestion, streams the scripted answer and still signs out", async ({ page }) => {
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    await openHome(page, "experts-suggestion");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Chat with the experts");
    await expect(page.getByRole("heading", { level: 2, name: "Head Coach" })).toBeVisible();
    await expect(page.getByText(NOTICE)).toHaveCount(0);

    const suggestion = page.getByRole("region", { name: "Head Coach" }).getByRole("button").first();
    const question = (await suggestion.textContent()) ?? "";

    expect(question).not.toBe("");

    await suggestion.click();

    const log = page.getByRole("log", { name: "Conversation" });

    await expect(log.getByText(question, { exact: true })).toBeVisible();
    await expect(log.getByText(SCRIPTED_ANSWER)).toBeVisible();
    await expect(log).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page).toHaveURL(/\/auth\/sign-in$/);
    expect(consoleErrors).toEqual([]);
  });

  test("sends a typed question with Enter", async ({ page }) => {
    await openHome(page, "experts-typed");
    await textbox(page).fill("What about the set pieces?");
    await textbox(page).press("Enter");

    const log = page.getByRole("log", { name: "Conversation" });

    await expect(log.getByText("What about the set pieces?")).toBeVisible();
    await expect(log.getByText(SCRIPTED_ANSWER)).toBeVisible();
    await expect(textbox(page)).toHaveValue("");
  });

  test("Stop ends a slow answer and leaves it marked as incomplete", async ({ page }) => {
    await openHome(page, "experts-stop");
    await textbox(page).fill("Tell me a long story [slow]");
    await textbox(page).press("Enter");

    const log = page.getByRole("log", { name: "Conversation" });

    await expect(log.getByText(/part 1/)).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();

    await expect(log.getByText("Incomplete answer")).toBeVisible();
    await expect(log.getByText(/part 1/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });

  test("shows the error of a failed answer with Try again", async ({ page }) => {
    await openHome(page, "experts-fail");
    await textbox(page).fill("This one fails [fail]");
    await textbox(page).press("Enter");

    await expect(page.getByText("The expert couldn't answer.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

    // The question is asked again, not duplicated.
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("The expert couldn't answer.")).toBeVisible();
    await expect(page.getByText("This one fails [fail]")).toHaveCount(1);
  });

  test("changes the panel, the notice and the conversation with the dropdown", async ({ page }) => {
    await openHome(page, "experts-switch");

    const select = page.getByRole("combobox", { name: "Expert" });

    await expect(select.locator("option")).toHaveCount(7);

    await select.selectOption("sports-lawyer");

    await expect(page.getByRole("heading", { level: 2, name: "Sports Lawyer" })).toBeVisible();
    await expect(page.getByText(NOTICE)).toBeVisible();
    await expect(textbox(page)).toHaveAccessibleDescription(NOTICE);

    await textbox(page).fill("Hello");
    await textbox(page).press("Enter");
    await expect(page.getByText(SCRIPTED_ANSWER)).toBeVisible();

    await select.selectOption("head-coach");

    await expect(page.getByRole("heading", { level: 2, name: "Head Coach" })).toBeVisible();
    await expect(page.getByText(SCRIPTED_ANSWER)).toHaveCount(0);
    await expect(page.getByText(NOTICE)).toHaveCount(0);
  });

  test("fits a 375 px screen: bar and header visible, no horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await openHome(page, "experts-mobile");

    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeInViewport();
    await expect(textbox(page)).toBeInViewport();
    await expect(page.getByRole("combobox", { name: "Expert" })).toBeInViewport();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );

    expect(overflows).toBe(false);
  });
});

test.describe("Conversation history", () => {
  const log = (page: Page) => page.getByRole("log", { name: "Conversation" });

  test("the conversation comes back after a reload, ending at the last message", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await openHome(page, "history-reload");

    for (const text of [
      "First question",
      "Second question",
      "Third question",
      "Fourth question",
      "Fifth question",
    ]) {
      await textbox(page).fill(text);
      await textbox(page).press("Enter");
      await expect(log(page)).toHaveAttribute("aria-busy", "false");
      await expect(log(page).getByText(text, { exact: true })).toBeVisible();
    }

    await expect(log(page).getByText(SCRIPTED_ANSWER)).toHaveCount(5);

    await page.reload();

    await expect(log(page).getByText("First question", { exact: true })).toBeAttached();
    await expect(log(page).getByText("Second question", { exact: true })).toBeAttached();
    await expect(log(page).getByText(SCRIPTED_ANSWER)).toHaveCount(5);
    // The list ends at the last message: the newest answer is in view, the first question is not.
    await expect(log(page).getByText(SCRIPTED_ANSWER).last()).toBeInViewport();
    await expect(log(page).getByText("First question", { exact: true })).not.toBeInViewport();
    await expect(page.getByRole("heading", { level: 2, name: "Head Coach" })).toHaveCount(0);
  });

  test("each expert has its own conversation, kept when switching back and forth", async ({
    page,
  }) => {
    await openHome(page, "history-switch");

    const select = page.getByRole("combobox", { name: "Expert" });

    await textbox(page).fill("For the head coach");
    await textbox(page).press("Enter");
    await expect(log(page).getByText(SCRIPTED_ANSWER)).toBeVisible();
    await expect(log(page)).toHaveAttribute("aria-busy", "false");

    await select.selectOption("physiologist");
    await expect(page.getByRole("heading", { level: 2, name: "Physiologist" })).toBeVisible();
    await expect(log(page).getByText("For the head coach")).toHaveCount(0);

    await textbox(page).fill("For the physiologist");
    await textbox(page).press("Enter");
    await expect(log(page).getByText(SCRIPTED_ANSWER)).toBeVisible();
    await expect(log(page)).toHaveAttribute("aria-busy", "false");

    await select.selectOption("head-coach");
    await expect(log(page).getByText("For the head coach")).toBeVisible();
    await expect(log(page).getByText("For the physiologist")).toHaveCount(0);

    await page.reload();
    await select.selectOption("physiologist");
    await expect(log(page).getByText("For the physiologist")).toBeVisible();
  });

  test("a stopped answer is still marked incomplete after a reload", async ({ page }) => {
    await openHome(page, "history-incomplete");
    await textbox(page).fill("Tell me a long story [slow]");
    await textbox(page).press("Enter");
    await expect(log(page).getByText(/part 1/)).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(log(page).getByText("Incomplete answer")).toBeVisible();

    // The server stores the partial text a moment after the connection closes.
    await expect(async () => {
      await page.reload();
      await expect(log(page).getByText("Incomplete answer")).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 10_000 });
    await expect(log(page).getByText(/part 1/)).toBeVisible();
    await expect(log(page).getByText("Tell me a long story [slow]")).toBeVisible();
  });

  test("Clear conversation asks first, then empties it for good", async ({ page }) => {
    await openHome(page, "history-clear");
    await textbox(page).fill("Something to forget");
    await textbox(page).press("Enter");
    await expect(log(page).getByText(SCRIPTED_ANSWER)).toBeVisible();
    await expect(log(page)).toHaveAttribute("aria-busy", "false");

    // Cancelling changes nothing.
    await page.getByRole("button", { name: "Clear conversation" }).click();

    const dialog = page.getByRole("alertdialog", { name: "Clear this conversation?" });

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(log(page).getByText("Something to forget")).toBeVisible();

    // Confirming deletes it, and a reload still shows the empty state.
    await page.getByRole("button", { name: "Clear conversation" }).click();
    await dialog.getByRole("button", { name: "Delete conversation" }).click();

    await expect(page.getByRole("heading", { level: 2, name: "Head Coach" })).toBeVisible();
    await expect(log(page).getByText("Something to forget")).toHaveCount(0);

    await page.reload();

    await expect(page.getByRole("heading", { level: 2, name: "Head Coach" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear conversation" })).toHaveCount(0);
  });

  test("signing out and back in keeps the conversation", async ({ page }) => {
    const { token, user } = await openHomeWithUser(page, "history-session");

    await textbox(page).fill("Remember me");
    await textbox(page).press("Enter");
    await expect(log(page).getByText(SCRIPTED_ANSWER)).toBeVisible();
    await expect(log(page)).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/auth\/sign-in$/);

    // A new session for the same person (the sign-in itself is covered by its own spec).
    const next = await issueAccessToken(user.id);

    expect(next).not.toBe(token);
    // Registered after the first init script, so it runs after it and the new token wins.
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [ACCESS_TOKEN_KEY, next],
    );
    await page.goto("/app");

    await expect(log(page).getByText("Remember me")).toBeVisible();
  });
});
