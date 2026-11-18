import { expect, test, type Page } from "@playwright/test";
import { buildJpeg, buildPng } from "../apps/api/src/modules/connections/testing/image-fixtures";
import { ACCESS_TOKEN_KEY, seedSignedInUser } from "./support/session";

// The API under test runs with NODE_ENV=test: the vision model is the scripted fake (it reads
// its instruction from markers inside the bytes of the image), embeddings are the offline fake and
// the chunks go to the local Weaviate, into the test collection. Nothing reaches OpenAI.
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
  // The stored conversation loads first and rebuilds the composer: wait for it.
  await expect(page.getByRole("textbox", { name: /^Message for the/ })).toBeEnabled();
}

const attach = (page: Page, name: string, mimeType: string, buffer: Buffer) =>
  page.getByTestId("connection-file-input").setInputFiles({ name, mimeType, buffer });

const attachments = (page: Page) => page.getByRole("list", { name: "Attachments" });
const isUpload = (response: { url(): string; request(): { method(): string } }) =>
  response.url().endsWith("/api/v1/connections") && response.request().method() === "POST";

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

test.describe("Connections: images", () => {
  test("attaches a PNG, waits until it is ready and enables Send; the same image again is instant", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    await openHome(page, "images-png");
    await page.getByRole("textbox", { name: /^Message for the/ }).fill("Who starts in midfield?");

    const image = buildPng({ note: "[vision-text:Midfield: Alves, Costa and Souza]" });
    const first = page.waitForResponse(isUpload);

    await attach(page, "escalacao.png", "image/png", image);

    const created = await first;

    expect(created.status()).toBe(202);
    expect(await created.json()).toMatchObject({ kind: "image", name: "escalacao.png" });
    await expect(attachments(page).getByText("escalacao.png")).toBeVisible();
    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    // Same bytes under another name: the API answers 200 with the existing connection.
    const second = page.waitForResponse(isUpload);

    await attach(page, "lineup-copy.png", "image/png", image);

    const response = await second;

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ deduplicated: true, status: "ready" });
    await expect(attachments(page).getByText("Ready")).toHaveCount(2);

    // No message is sent here: the messages endpoint shares a quota of 20 a minute with the suite.
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(consoleErrors).toEqual([]);
  });

  test("attaches a JPEG", async ({ page }) => {
    await openHome(page, "images-jpeg");
    await attach(page, "sumula.jpg", "image/jpeg", buildJpeg({ note: "[vision-text:Final 2-1]" }));

    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 15_000 });
  });

  test("explains an image without content, and Remove clears the chip", async ({ page }) => {
    await openHome(page, "images-blank");
    await attach(page, "blank.png", "image/png", buildPng({ note: "[vision-blank]" }));

    await expect(
      page.getByText(
        "We couldn't find any text or relevant content in this image. Send a clearer, well-lit image.",
      ),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Remove blank.png" }).click();

    await expect(attachments(page)).toHaveCount(0);
  });

  test("explains a refusal of the provider", async ({ page }) => {
    await openHome(page, "images-refused");
    await attach(page, "refused.png", "image/png", buildPng({ note: "[vision-refuse]" }));

    await expect(
      page.getByText("The AI provider couldn't process this image. Try another image."),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("refuses a GIF renamed to .png, by its bytes", async ({ page }) => {
    await openHome(page, "images-gif");
    await attach(page, "anim.png", "image/png", Buffer.from("GIF89a\u0001\u0000\u0001\u0000 data"));

    await expect(
      page.getByText("Only PDF, TXT, Markdown, JPG, PNG, MP3 and MP4 files are supported."),
    ).toBeVisible();
  });

  test("refuses an image above 8,000 px", async ({ page }) => {
    await openHome(page, "images-huge");
    await attach(page, "huge.png", "image/png", buildPng({ width: 9000, height: 9000 }));

    await expect(
      page.getByText("Images can have at most 8,000 pixels on each side."),
    ).toBeVisible();
  });
});
