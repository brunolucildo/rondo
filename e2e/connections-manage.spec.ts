import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { query } from "./support/database";
import { ACCESS_TOKEN_KEY, seedSignedInUser } from "./support/session";

// The API under test runs with NODE_ENV=test: the chat model and the embeddings are the offline
// fakes (no OpenAI) and the chunks go to the local Weaviate, into the test collection. The fake
// embeddings carry no meaning.
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const PLAN_SENTENCE = "The recovery session for week three is forty minutes of low intensity work.";
const NOTES_SENTENCE = "The travel notes say the squad leaves at seven in the morning on Friday.";
const tenants: string[] = [];

async function openHome(page: Page, label: string): Promise<string> {
  const { user, token } = await seedSignedInUser(label, "Eva", "Lima");

  tenants.push(`u_${user.id.replaceAll("-", "")}`);
  await page.addInitScript(
    ([tokenKey, tokenValue, privacyKey, themeKey]) => {
      window.localStorage.setItem(tokenKey as string, tokenValue as string);
      window.localStorage.setItem(privacyKey as string, "true");
      window.localStorage.setItem(themeKey as string, "light");
    },
    [ACCESS_TOKEN_KEY, token, PRIVACY_KEY, "rondo-theme"],
  );
  await page.goto("/app");
  await expect(page.getByRole("combobox", { name: "Expert" })).toBeVisible();
  // The stored conversation loads first: the field is ready once it arrived.
  await expect(textbox(page)).toBeEnabled();

  return user.id;
}

const textbox = (page: Page) => page.getByRole("textbox", { name: /^Message for the/ });
const log = (page: Page) => page.getByRole("log", { name: "Conversation" });
const attachments = (page: Page) => page.getByRole("list", { name: "Attachments" });
const sources = (page: Page) => page.getByRole("region", { name: "Sources" });
const panel = (page: Page) => page.getByRole("dialog", { name: "Connections" });
const confirmation = (page: Page) => page.getByRole("alertdialog");
const isUpload = (response: { url(): string; request(): { method(): string } }) =>
  response.url().endsWith("/api/v1/connections") && response.request().method() === "POST";

const attachText = (page: Page, name: string, text: string) =>
  page
    .getByTestId("connection-file-input")
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text, "utf8") });

/** Connects a file and waits until it is ready; returns the id of the connection. */
async function connect(page: Page, name: string, text: string): Promise<string> {
  const upload = page.waitForResponse(isUpload);

  await attachText(page, name, text);

  const { id } = (await (await upload).json()) as { id: string };

  await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });

  return id;
}

/**
 * An answer of the expert that cites the file, stored like the server stores it. Seeded in the
 * database: the messages endpoint is rate limited per IP and the whole suite shares that quota.
 */
async function storeCitedAnswer(userId: string, connectionId: string, sourceName: string) {
  const append = (role: "user" | "assistant", content: string, citations: unknown) =>
    query(
      "select * from public.expert_append_message($1, 'head-coach', $2, $3, 'complete', 100, $4::jsonb)",
      [userId, role, content, citations === null ? null : JSON.stringify(citations)],
    );

  await append("user", "What is in my plan?", null);
  await append("assistant", "Based on your connected sources, this is a stored answer.", [
    { connectionId, sourceName, page: null, position: 0 },
  ]);
}

async function openPanel(page: Page) {
  await page.getByRole("button", { name: "Your connections" }).click();
  await expect(panel(page)).toBeVisible();
}

test.afterAll(async () => {
  // Chunks of the test users stay in Weaviate after the database rows are gone: drop the tenants.
  const base = process.env.WEAVIATE_URL ?? "http://localhost:8080";
  const collection = process.env.WEAVIATE_COLLECTION ?? "KnowledgeChunkTest";

  await Promise.all(
    tenants.map((tenant) =>
      fetch(`${base}/v1/schema/${collection}/tenants`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${process.env.WEAVIATE_API_KEY ?? ""}`,
          "content-type": "application/json",
        },
        body: JSON.stringify([tenant]),
      }).catch(() => undefined),
    ),
  );
});

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );

  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.length} node(s)`)).toEqual(
    [],
  );
}

// The messages endpoint is limited per IP and the whole suite shares that quota: this spec sends
// none (the answer it needs is stored directly).
test.describe("Manage connections", () => {
  test("lists, cancels, deletes one, shows 'Source removed', deletes all and reprocesses a re-sent file", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    const userId = await openHome(page, "manage-connections");

    // The expert answered once, citing the first file; then a second file is added.
    const planId = await connect(page, "weekly-plan.txt", PLAN_SENTENCE);

    await storeCitedAnswer(userId, planId, "weekly-plan.txt");
    await page.reload();
    await expect(textbox(page)).toBeEnabled();
    await expect(sources(page).getByRole("listitem")).toHaveText(["weekly-plan.txt"]);
    await connect(page, "travel-notes.txt", NOTES_SENTENCE);

    // The panel lists both, the most recent first.
    await openPanel(page);

    const list = panel(page).getByRole("list", { name: "Your connections" });

    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("listitem").first()).toContainText("travel-notes.txt");
    await expect(list.getByRole("listitem").nth(1)).toContainText("weekly-plan.txt");
    await expect(list.getByRole("listitem").first()).toContainText("Ready");
    await expectAccessible(page);

    // Cancelling the confirmation changes nothing.
    await panel(page).getByRole("button", { name: "Delete weekly-plan.txt" }).click();
    await expect(confirmation(page)).toContainText("This can't be undone");
    await expect(confirmation(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(confirmation(page)).toHaveCount(0);
    await expect(list.getByRole("listitem")).toHaveCount(2);

    // Confirming deletes it on the server, and the panel and the chat both stop showing the name.
    await panel(page).getByRole("button", { name: "Delete weekly-plan.txt" }).click();

    const deletion = page.waitForResponse(
      (response) => response.request().method() === "DELETE" && response.status() === 204,
    );

    await confirmation(page).getByRole("button", { name: "Delete connection" }).click();
    await deletion;
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).not.toContainText("weekly-plan.txt");
    await panel(page).getByRole("button", { name: "Close" }).click();
    await expect(sources(page).getByRole("listitem")).toHaveText(["Source removed"]);
    await expect(log(page)).toContainText("this is a stored answer");

    // After a reload the server itself says the source is gone, and never sends its name.
    await page.reload();
    await expect(textbox(page)).toBeEnabled();
    await expect(sources(page).getByRole("listitem")).toHaveText(["Source removed"]);
    await expect(page.getByText("weekly-plan.txt")).toHaveCount(0);

    // Sending the same file again processes it from scratch (not a duplicate).
    const again = page.waitForResponse(isUpload);

    await attachText(page, "weekly-plan.txt", PLAN_SENTENCE);

    const answer = await again;

    expect(answer.status()).toBe(202);
    expect(await answer.json()).toMatchObject({ deduplicated: false, status: "processing" });
    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });

    // Delete all names the quantity and removes everything.
    await openPanel(page);
    await expect(panel(page).getByRole("list", { name: "Your connections" })).toBeVisible();
    await panel(page).getByRole("button", { name: "Delete all" }).click();
    await expect(confirmation(page)).toContainText("Delete all 2 connections?");
    await expect(confirmation(page)).toContainText("can't be undone");
    await confirmation(page).getByRole("button", { name: "Delete all" }).click();
    await expect(panel(page).getByText("No connections yet")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Add a file" })).toBeVisible();
    await expectAccessible(page);

    expect(consoleErrors).toEqual([]);
  });

  test("works by keyboard at 375 px without horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openHome(page, "manage-connections-mobile");
    await connect(page, "weekly-plan.txt", PLAN_SENTENCE);

    const opener = page.getByRole("button", { name: "Your connections" });

    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole("listitem")).toHaveCount(1);

    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );

    expect(fits).toBe(true);

    const remove = panel(page).getByRole("button", { name: "Delete weekly-plan.txt" });

    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(confirmation(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      confirmation(page).getByRole("button", { name: "Delete connection" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel(page).getByText("No connections yet")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});
