import { expect, test, type Page } from "@playwright/test";
import {
  buildPdf,
  sentences,
  wrapLines,
} from "../apps/api/src/modules/connections/testing/pdf-fixtures";
import { ACCESS_TOKEN_KEY, seedSignedInUser } from "./support/session";

// The API under test runs with NODE_ENV=test: embeddings are the offline fake (no OpenAI) and the
// chunks go to the local Weaviate, into the test collection.
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const tenants: string[] = [];

async function openHome(page: Page, label: string, { acceptedPrivacy = true } = {}) {
  const { user, token } = await seedSignedInUser(label, "Eva", "Lima");

  tenants.push(`u_${user.id.replaceAll("-", "")}`);
  await page.addInitScript(
    ([tokenKey, tokenValue, privacyKey, accepted]) => {
      window.localStorage.setItem(tokenKey as string, tokenValue as string);

      if (accepted === "yes") {
        window.localStorage.setItem(privacyKey as string, "true");
      }
    },
    [ACCESS_TOKEN_KEY, token, PRIVACY_KEY, acceptedPrivacy ? "yes" : "no"],
  );
  await page.goto("/app");
  await expect(page.getByRole("combobox", { name: "Expert" })).toBeVisible();
}

const plan = () =>
  buildPdf([
    wrapLines(sentences("The first page", 20)),
    wrapLines(sentences("The second page", 20)),
    wrapLines(sentences("The third page", 20)),
  ]);

const attach = (page: Page, name: string, mimeType: string, buffer: Buffer) =>
  page.getByTestId("connection-file-input").setInputFiles({ name, mimeType, buffer });

const attachments = (page: Page) => page.getByRole("list", { name: "Attachments" });
const isUpload = (response: { url(): string; request(): { method(): string } }) =>
  response.url().endsWith("/api/v1/connections") && response.request().method() === "POST";

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

test.describe("Connections: text files", () => {
  test("attaches a PDF, waits until it is ready and sends; the same file again is instant", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    await openHome(page, "connections-pdf");
    await page.getByRole("textbox", { name: /^Message for the/ }).fill("What is in my plan?");

    const first = page.waitForResponse(isUpload);

    await attach(page, "plano.pdf", "application/pdf", plan());

    expect((await first).status()).toBe(202);
    await expect(attachments(page).getByText("plano.pdf")).toBeVisible();
    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    // Same bytes under another name: the API answers 200 with the existing connection.
    const second = page.waitForResponse(isUpload);

    await attach(page, "copy-of-plan.pdf", "application/pdf", plan());

    const response = await second;

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ deduplicated: true, status: "ready" });
    await expect(attachments(page).getByText("copy-of-plan.pdf")).toBeVisible();
    await expect(attachments(page).getByText("Ready")).toHaveCount(2);

    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("log", { name: "Conversation" })).toContainText(
      "What is in my plan?",
    );
    await expect(attachments(page)).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  });

  test("attaches Markdown and plain text", async ({ page }) => {
    await openHome(page, "connections-text");
    await attach(page, "notes.md", "text/markdown", Buffer.from("# Notes\n\nRecovery matters.\n"));
    await attach(page, "list.txt", "text/plain", Buffer.from("Squad list for the week.\n"));

    await expect(attachments(page).getByText("Ready")).toHaveCount(2, { timeout: 15_000 });
  });

  test("explains a scanned PDF and Remove clears the chip", async ({ page }) => {
    await openHome(page, "connections-scan");
    await attach(page, "scan.pdf", "application/pdf", buildPdf([[], []]));

    await expect(
      page.getByText("We couldn't find any text in this file. Scanned PDFs are not supported yet."),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Remove scan.pdf" }).click();

    await expect(attachments(page)).toHaveCount(0);
  });

  test("refuses a program renamed to .pdf, by its bytes", async ({ page }) => {
    await openHome(page, "connections-fake");
    await attach(page, "fake.pdf", "application/pdf", Buffer.from("MZ this is not a pdf"));

    await expect(page.getByText("Only PDF, TXT and Markdown files are supported.")).toBeVisible();
  });

  test("shows the privacy notice first, and Cancel uploads nothing", async ({ page }) => {
    let uploads = 0;

    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/connections")) {
        uploads += 1;
      }
    });
    await openHome(page, "connections-privacy", { acceptedPrivacy: false });
    await attach(page, "plano.pdf", "application/pdf", plan());

    const dialog = page.getByRole("dialog", { name: "Before you connect a file" });

    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(attachments(page)).toHaveCount(0);
    expect(uploads).toBe(0);

    await attach(page, "plano.pdf", "application/pdf", plan());
    await page.getByRole("dialog").getByRole("button", { name: "I understand, continue" }).click();

    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });
    expect(uploads).toBe(1);
  });

  test("keeps the button reachable by keyboard and 44 px high at 375 px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await openHome(page, "connections-mobile");

    const button = page.getByRole("button", { name: "Add connection" });
    const box = await button.boundingBox();

    expect(box?.height).toBeGreaterThanOrEqual(44);
    await button.focus();
    await expect(button).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  });
});
