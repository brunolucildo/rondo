import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ACCESS_TOKEN_KEY, seedSignedInUser } from "./support/session";

// The API under test runs with NODE_ENV=test: the chat model and the embeddings are the offline
// fakes (no OpenAI) and the chunks go to the local Weaviate, into the test collection. The fake
// embeddings carry no meaning (only an identical text is close to a chunk), so the question that
// "is about" a file is the very sentence the file holds.
const GROUNDED_ANSWER = "Based on your connected sources, this is a scripted answer.";
const NO_SOURCE_ANSWER =
  "No connected source covers this question. This is scripted general guidance, with no source.";
const GAP_NOTICE = "No connected source covers this.";
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const THEME_KEY = "rondo-theme";
const SENTENCE = "The recovery session for week three is forty minutes of low intensity work.";
const tenants: string[] = [];

async function openHome(page: Page, label: string) {
  const { user, token } = await seedSignedInUser(label, "Eva", "Lima");

  tenants.push(`u_${user.id.replaceAll("-", "")}`);
  await page.addInitScript(
    ([tokenKey, tokenValue, privacyKey, themeKey]) => {
      window.localStorage.setItem(tokenKey as string, tokenValue as string);
      window.localStorage.setItem(privacyKey as string, "true");

      // The light theme to start with; a test that switches it keeps its choice on reload.
      if (window.localStorage.getItem(themeKey as string) === null) {
        window.localStorage.setItem(themeKey as string, "light");
      }
    },
    [ACCESS_TOKEN_KEY, token, PRIVACY_KEY, THEME_KEY],
  );
  await page.goto("/app");
  await expect(page.getByRole("combobox", { name: "Expert" })).toBeVisible();
  // The stored conversation loads first: the field is ready once it arrived.
  await expect(textbox(page)).toBeEnabled();
}

const textbox = (page: Page) => page.getByRole("textbox", { name: /^Message for the/ });
const log = (page: Page) => page.getByRole("log", { name: "Conversation" });
const attachments = (page: Page) => page.getByRole("list", { name: "Attachments" });
const sources = (page: Page) => page.getByRole("region", { name: "Sources" });
const isUpload = (response: { url(): string; request(): { method(): string } }) =>
  response.url().endsWith("/api/v1/connections") && response.request().method() === "POST";

const attachText = (page: Page, name: string, text = SENTENCE) =>
  page
    .getByTestId("connection-file-input")
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text, "utf8") });

async function ask(page: Page, question: string) {
  await textbox(page).fill(question);
  await page.getByRole("button", { name: "Send" }).click();
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

/** No serious or critical axe violation (WCAG 2.x A and AA) in the theme the page is in. */
async function expectAccessible(page: Page, theme: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

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

/** Switches to the dark theme and reloads: the stored conversation comes back with its sources. */
async function reloadInDarkTheme(page: Page) {
  await page.evaluate((key) => window.localStorage.setItem(key, "dark"), THEME_KEY);
  await page.reload();
  await expect(textbox(page)).toBeEnabled();
}

// The messages endpoint is limited to 20 per minute per IP and the whole suite shares that quota:
// this spec sends only three messages in all.
test.describe("Answers grounded on the connected sources", () => {
  test("answers from the attached file, then from the whole base, with the sources kept after reloading", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    await openHome(page, "grounded-answer");

    const upload = page.waitForResponse(isUpload);

    await attachText(page, "weekly-plan.txt");

    expect((await upload).status()).toBe(202);
    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });

    await ask(page, SENTENCE);

    await expect(log(page).getByText(GROUNDED_ANSWER)).toBeVisible();
    await expect(sources(page).getByRole("listitem")).toHaveText(["weekly-plan.txt"]);
    await expect(page.getByText(GAP_NOTICE)).toHaveCount(0);
    await expect(attachments(page)).toHaveCount(0);

    // Nothing is attached now: the search covers everything the user has connected.
    await ask(page, SENTENCE);

    await expect(log(page).getByText(GROUNDED_ANSWER)).toHaveCount(2);
    await expect(sources(page)).toHaveCount(2);

    await page.reload();
    await expect(textbox(page)).toBeEnabled();

    await expect(log(page).getByText(GROUNDED_ANSWER)).toHaveCount(2);
    await expect(sources(page).first().getByRole("listitem")).toHaveText(["weekly-plan.txt"]);
    await expectAccessible(page, "light");
    await reloadInDarkTheme(page);
    await expect(sources(page)).toHaveCount(2);
    await expectAccessible(page, "dark");
    expect(consoleErrors).toEqual([]);
  });

  test("says that no connected source covers an unrelated question, with no list, in both themes", async ({
    page,
  }) => {
    await openHome(page, "grounded-gap");
    await attachText(page, "weekly-plan.txt");
    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });

    await ask(page, "Who won the national league in 1998?");

    await expect(log(page).getByText(NO_SOURCE_ANSWER)).toBeVisible();
    await expect(page.getByText(GAP_NOTICE)).toBeVisible();
    await expect(sources(page)).toHaveCount(0);

    await page.reload();
    await expect(textbox(page)).toBeEnabled();

    await expect(page.getByText(GAP_NOTICE)).toBeVisible();
    await expect(sources(page)).toHaveCount(0);
    await expectAccessible(page, "light");
    await reloadInDarkTheme(page);
    await expect(page.getByText(GAP_NOTICE)).toBeVisible();
    await expectAccessible(page, "dark");
  });
});
