import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ACCESS_TOKEN_KEY, seedSignedInUser } from "./support/session";

// The API under test runs with NODE_ENV=test: embeddings are the offline fake and the web is a
// small scripted one (`createScriptedWeb`) below the real egress protection, so nothing reaches
// the internet and `localhost` or the metadata address are still refused by the guard itself.
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const tenants: string[] = [];

async function openHome(page: Page, label: string) {
  const { user, token } = await seedSignedInUser(label, "Eva", "Lima");

  tenants.push(`u_${user.id.replaceAll("-", "")}`);
  await page.addInitScript(
    ([tokenKey, tokenValue, privacyKey]) => {
      window.localStorage.setItem(tokenKey as string, tokenValue as string);
      window.localStorage.setItem(privacyKey as string, "true");
    },
    [ACCESS_TOKEN_KEY, token, PRIVACY_KEY],
  );
  await page.goto("/app");
  await expect(page.getByRole("combobox", { name: "Expert" })).toBeVisible();
  // The stored conversation loads first and rebuilds the composer: wait for it before interacting.
  await expect(page.getByRole("textbox", { name: /^Message for the/ })).toBeEnabled();
}

const attachments = (page: Page) => page.getByRole("list", { name: "Attachments" });
const isLinkPost = (response: { url(): string; request(): { method(): string } }) =>
  response.url().endsWith("/api/v1/connections/url") && response.request().method() === "POST";

async function addLink(page: Page, url: string) {
  await page.getByRole("button", { name: "Add link" }).click();

  const dialog = page.getByRole("dialog", { name: "Add a link" });

  await dialog.getByRole("textbox", { name: "Link" }).fill(url);
  await dialog.getByRole("button", { name: "Connect link" }).click();
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

test.describe("Connections: links", () => {
  test("connects a public page, deduplicates the same link and the same text", async ({ page }) => {
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    await openHome(page, "connections-url");
    await page
      .getByRole("textbox", { name: /^Message for the/ })
      .fill("What does the regulation say?");

    const first = page.waitForResponse(isLinkPost);

    await addLink(page, "https://docs.example.test/regulation?token=SEGREDO#section");

    expect((await first).status()).toBe(202);
    // The chip shows host and path, never the query that may hold a token.
    await expect(attachments(page).getByText("docs.example.test/regulation")).toBeVisible();
    await expect(attachments(page)).not.toContainText("SEGREDO");
    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    // The same page by another address (host in capitals, tracking, trailing slash): no request needed.
    const again = page.waitForResponse(isLinkPost);

    await addLink(
      page,
      "https://DOCS.example.test/regulation/?utm_source=news&token=SEGREDO#other",
    );

    const dedup = await again;

    expect(dedup.status()).toBe(200);
    expect(await dedup.json()).toMatchObject({ deduplicated: true, status: "ready" });

    // Another address with the same text: the answer is the first connection.
    const mirror = page.waitForResponse(isLinkPost);

    await addLink(page, "https://mirror.example.test/regulation");

    const mirrored = await mirror;

    expect(mirrored.status()).toBe(200);
    expect(await mirrored.json()).toMatchObject({ deduplicated: true, status: "ready" });
    await expect(attachments(page).getByText("Ready")).toHaveCount(3);

    // No message is sent here: the answers of the experts are limited per IP (20 a minute) and
    // `experts-grounded-answers.spec.ts` counts on the budget. Sending with a link attached is the
    // same request as with a file (`connectionIds`), covered by the component and API tests.
    expect(consoleErrors).toEqual([]);
  });

  test("lists the link in the panel with its kind", async ({ page }) => {
    await openHome(page, "connections-url-panel");
    await addLink(page, "https://docs.example.test/regulation");
    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /Your connections/ }).click();

    const panel = page.getByRole("dialog", { name: "Connections" });

    await expect(panel.getByText("Match regulation 2026")).toBeVisible();
    await expect(panel.getByText(/Link ·/)).toBeVisible();
  });

  test("refuses destinations that are not public without revealing why", async ({ page }) => {
    await openHome(page, "connections-url-blocked");

    for (const url of ["http://localhost:80/admin", "http://169.254.169.254/latest/meta-data/"]) {
      const response = page.waitForResponse(isLinkPost);

      await addLink(page, url);

      expect((await response).status()).toBe(400);
    }

    const chips = attachments(page).getByText("This link can't be used.");

    await expect(chips).toHaveCount(2);
    await expect(attachments(page)).not.toContainText(/private|internal|metadata|blocked/i);
  });

  test("explains a link that is plainly wrong next to the field and keeps the text", async ({
    page,
  }) => {
    let posts = 0;

    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/connections/url")) {
        posts += 1;
      }
    });
    await openHome(page, "connections-url-invalid");
    await page.getByRole("button", { name: "Add link" }).click();

    const dialog = page.getByRole("dialog", { name: "Add a link" });
    const field = dialog.getByRole("textbox", { name: "Link" });

    await expect(dialog.getByRole("button", { name: "Connect link" })).toBeDisabled();
    await field.fill("ftp://docs.example.test/file");
    await dialog.getByRole("button", { name: "Connect link" }).click();

    await expect(dialog.getByText("Links must start with http:// or https://.")).toBeVisible();
    await expect(field).toHaveValue("ftp://docs.example.test/file");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    expect(posts).toBe(0);

    const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();

    expect(
      results.violations.filter(({ impact }) => impact === "serious" || impact === "critical"),
    ).toEqual([]);
  });

  test("tells a page without text and a file that is not a page apart", async ({ page }) => {
    await openHome(page, "connections-url-unusable");
    await addLink(page, "https://docs.example.test/script-only");
    await expect(attachments(page).getByText(/couldn't find any text on this page/)).toBeVisible({
      timeout: 15_000,
    });

    await addLink(page, "https://docs.example.test/image");
    await expect(
      attachments(page).getByText(
        "This link must lead to a web page, a text file, Markdown or a PDF.",
      ),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("keeps the three buttons reachable and the page without horizontal scroll at 375 px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await openHome(page, "connections-url-mobile");

    for (const name of [/Your connections/, "Add connection", "Add link"]) {
      const button = page.getByRole("button", { name });
      const box = await button.boundingBox();

      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  });
});
