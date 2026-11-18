import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ACCESS_TOKEN_KEY, seedSignedInUser } from "./support/session";

/**
 * Captures the screenshots of the product home (chat with the experts) used by the documentation
 * (`.docs/HOME.md`, `.screenshots/home-experts/README.md`).
 *
 * It is NOT part of the regular suite: it only runs with `CAPTURE_DOCS=1`, because it sends two
 * messages and the messages endpoint shares a 20 per minute quota with the rest of the suite.
 *
 *   CAPTURE_DOCS=1 bunx playwright test e2e/docs-screenshots.spec.ts
 *
 * Like every E2E, the API runs with NODE_ENV=test: the chat model and the embeddings are the offline
 * fakes (no OpenAI), so the answers are scripted. The screens, the sources and the history are real.
 */
const OUT_DIR = join(process.cwd(), ".screenshots", "home-experts");
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const THEME_KEY = "rondo-theme";
const SENTENCE = "The recovery session for week three is forty minutes of low intensity work.";
const UNRELATED = "Which stadium hosted the first match of the season?";
const tenants: string[] = [];

test.skip(process.env.CAPTURE_DOCS !== "1", "Documentation screenshots: run with CAPTURE_DOCS=1.");

const textbox = (page: Page) => page.getByRole("textbox", { name: /^Message for the/ });
const log = (page: Page) => page.getByRole("log", { name: "Conversation" });
const sources = (page: Page) => page.getByRole("region", { name: "Sources" });
const isUpload = (response: { url(): string; request(): { method(): string } }) =>
  response.url().endsWith("/api/v1/connections") && response.request().method() === "POST";

async function shot(page: Page, name: string) {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: join(OUT_DIR, `${name}.png`), animations: "disabled" });
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [THEME_KEY, theme],
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(textbox(page)).toBeEnabled();
}

test.afterAll(async () => {
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

test("captures the home of the product: chat, sources, gap, panel, themes and mobile", async ({
  page,
}) => {
  const { user, token } = await seedSignedInUser("docs-screenshots", "Alex", "Morgan");

  tenants.push(`u_${user.id.replaceAll("-", "")}`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(
    ([tokenKey, tokenValue, privacyKey, themeKey]) => {
      window.localStorage.setItem(tokenKey as string, tokenValue as string);
      window.localStorage.setItem(privacyKey as string, "true");

      if (window.localStorage.getItem(themeKey as string) === null) {
        window.localStorage.setItem(themeKey as string, "light");
      }
    },
    [ACCESS_TOKEN_KEY, token, PRIVACY_KEY, THEME_KEY],
  );
  await page.goto("/app");
  await expect(page.getByRole("combobox", { name: "Expert" })).toBeVisible();
  await expect(textbox(page)).toBeEnabled();

  // 1. Empty state: the expert, the persona and the suggested questions.
  await shot(page, "01-chat-empty-light");

  // 2. An expert that carries the professional notice.
  await page.getByRole("combobox", { name: "Expert" }).selectOption("sports-physician");
  await expect(page.getByText("Informational support only.").first()).toBeVisible();
  await shot(page, "02-expert-with-professional-notice");
  await page.getByRole("combobox", { name: "Expert" }).selectOption("head-coach");
  // Switching expert reloads the stored conversation: the composer is rebuilt and disabled until it arrives.
  await expect(textbox(page)).toBeEnabled();

  // 3. A file connected and ready, before the question.
  const upload = page.waitForResponse(isUpload);

  await page.getByTestId("connection-file-input").setInputFiles({
    name: "weekly-plan.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(SENTENCE, "utf8"),
  });
  expect((await upload).status()).toBe(202);
  await expect(page.getByRole("list", { name: "Attachments" }).getByText("Ready")).toBeVisible({
    timeout: 15_000,
  });
  await shot(page, "03-attachment-ready");

  // 4. The answer grounded on the file, with the sources the server built.
  await textbox(page).fill(SENTENCE);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(sources(page).getByRole("listitem")).toHaveText(["weekly-plan.txt"]);
  await shot(page, "04-answer-with-sources");

  // 5. A question no source covers: the gap is declared, with no list of sources.
  await textbox(page).fill(UNRELATED);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("No connected source covers this.")).toBeVisible();
  await shot(page, "05-gap-no-source");

  // 6. The panel that lists and deletes the connections.
  await page.getByRole("button", { name: "Your connections" }).click();
  await expect(page.getByRole("list", { name: "Your connections" })).toBeVisible();
  await shot(page, "06-connections-panel");
  await page.keyboard.press("Escape");

  // 7. The same conversation after a reload, in the dark theme (the history is kept on the server).
  await setTheme(page, "dark");
  await expect(log(page).getByRole("listitem").first()).toBeVisible();
  await shot(page, "07-history-after-reload-dark");

  // 8. Mobile, light theme.
  await setTheme(page, "light");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(textbox(page)).toBeEnabled();
  await shot(page, "08-mobile-light");
});
