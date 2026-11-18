import { expect, test, type Page } from "@playwright/test";
import { buildMp3, buildMp4 } from "../apps/api/src/modules/connections/testing/media-fixtures";
import { query } from "./support/database";
import { ACCESS_TOKEN_KEY, seedSignedInUser } from "./support/session";

// The API under test runs with NODE_ENV=test: the media provider (Gemini), the embeddings and the
// chat model are the offline fakes (no network) and the chunks go to the local Weaviate, into the
// test collection. The messages endpoint is limited to 20 per minute per IP and the whole suite
// shares that quota, so the answer that cites a media is stored in the database like the server
// stores it (the streamed path is covered by the integration test) instead of being asked for.
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const PRIVACY_MEDIA_KEY = "rondo.connections.privacy-media-accepted";
const SENTENCE = "The exit from the back starts with the goalkeeper and the two center backs.";
const tenants: string[] = [];

async function openHome(
  page: Page,
  label: string,
  { acceptedMediaPrivacy = true } = {},
): Promise<string> {
  const { user, token } = await seedSignedInUser(label, "Eva", "Lima");

  tenants.push(`u_${user.id.replaceAll("-", "")}`);
  await page.addInitScript(
    ([tokenKey, tokenValue, privacyKey, mediaKey, accepted]) => {
      window.localStorage.setItem(tokenKey as string, tokenValue as string);
      window.localStorage.setItem(privacyKey as string, "true");

      if (accepted === "yes") {
        window.localStorage.setItem(mediaKey as string, "true");
      }
    },
    [ACCESS_TOKEN_KEY, token, PRIVACY_KEY, PRIVACY_MEDIA_KEY, acceptedMediaPrivacy ? "yes" : "no"],
  );
  await page.goto("/app");
  await expect(page.getByRole("combobox", { name: "Expert" })).toBeVisible();
  // The stored conversation loads first and rebuilds the composer: wait for it, or the field
  // that a test fills can be replaced under load.
  await expect(textbox(page)).toBeEnabled();

  return user.id;
}

/** An answer of the expert that cites the media at an instant, stored like the server stores it. */
async function storeCitedAnswer(userId: string, connectionId: string, sourceName: string) {
  const append = (role: "user" | "assistant", content: string, citations: unknown) =>
    query(
      "select * from public.expert_append_message($1, 'head-coach', $2, $3, 'complete', 100, $4::jsonb)",
      [userId, role, content, citations === null ? null : JSON.stringify(citations)],
    );

  await append("user", "What did the coach say about the exit?", null);
  await append("assistant", "Based on your connected sources, this is a stored answer.", [
    { connectionId, sourceName, page: null, position: 0, startSeconds: 750 },
  ]);
}

const textbox = (page: Page) => page.getByRole("textbox", { name: /^Message for the/ });
const attachments = (page: Page) => page.getByRole("list", { name: "Attachments" });
const sources = (page: Page) => page.getByRole("region", { name: "Sources" });
const isUpload = (response: { url(): string; request(): { method(): string } }) =>
  response.url().endsWith("/api/v1/connections") && response.request().method() === "POST";

const attach = (page: Page, name: string, mimeType: string, buffer: Buffer) =>
  page.getByTestId("connection-file-input").setInputFiles({ name, mimeType, buffer });

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

test.describe("Connections: audio and video", () => {
  test("attaches an MP3, waits for it and sees the instant (mm:ss) in the source of a stored answer", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    const userId = await openHome(page, "media-audio");

    const upload = page.waitForResponse(isUpload);

    await attach(
      page,
      "talk.mp3",
      "audio/mpeg",
      buildMp3({ script: `[12:30] ${SENTENCE}`, salt: "e2e-audio" }),
    );

    const response = await upload;

    expect(response.status()).toBe(202);
    expect(await response.json()).toMatchObject({ kind: "audio", status: "processing" });
    await expect(attachments(page).getByText("talk.mp3")).toBeVisible();
    // The first check of a media is after about two seconds.
    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 20_000 });

    const connection = (await response.json()) as { id: string };

    await storeCitedAnswer(userId, connection.id, "talk.mp3");
    await page.reload();
    await expect(textbox(page)).toBeEnabled();

    await expect(sources(page)).toBeVisible();
    await expect(sources(page)).toContainText("talk.mp3 · 12:30");
    expect(consoleErrors).toEqual([]);
  });

  test("attaches an MP4, shows the long wait message, and the same video again is instant", async ({
    page,
  }) => {
    await openHome(page, "media-video");

    const bytes = () =>
      buildMp4({
        durationSeconds: 480,
        script: `[03:42] ${SENTENCE}\n[03:50] SCENE: the scoreboard reads 2-1.`,
        salt: "e2e-video",
      });
    const first = page.waitForResponse(isUpload);

    await attach(page, "analysis.mp4", "video/mp4", bytes());

    expect((await first).status()).toBe(202);
    await expect(attachments(page).getByText("This can take a few minutes.")).toBeVisible();
    await expect(attachments(page).getByText("Ready")).toBeVisible({ timeout: 20_000 });

    const second = page.waitForResponse(isUpload);

    await attach(page, "copy-of-analysis.mp4", "video/mp4", bytes());

    const again = await second;

    expect(again.status()).toBe(200);
    expect(await again.json()).toMatchObject({
      deduplicated: true,
      status: "ready",
      kind: "video",
    });
    await expect(attachments(page).getByText("Ready")).toHaveCount(2);
  });

  test("explains a silent audio and refuses a WAV renamed to .mp3", async ({ page }) => {
    await openHome(page, "media-errors");
    await attach(
      page,
      "silence.mp3",
      "audio/mpeg",
      buildMp3({ fail: "NO_CONTENT", salt: "e2e-silence" }),
    );

    await expect(
      page.getByText("We couldn't find any speech or content in this audio or video."),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Remove silence.mp3" }).click();

    await attach(page, "fake.mp3", "audio/mpeg", Buffer.from("RIFF....WAVEfmt  not an mp3"));

    await expect(
      page.getByText("Only PDF, TXT, Markdown, MP3 and MP4 files are supported."),
    ).toBeVisible();
  });

  test("shows the media privacy notice (voice and image go to Gemini) before the first audio, and Cancel uploads nothing", async ({
    page,
  }) => {
    let uploads = 0;

    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/connections")) {
        uploads += 1;
      }
    });
    await openHome(page, "media-privacy", { acceptedMediaPrivacy: false });
    await attach(page, "talk.mp3", "audio/mpeg", buildMp3({ salt: "e2e-privacy" }));

    const dialog = page.getByRole("dialog", { name: "Before you connect a file" });

    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("voice and the image of people");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(attachments(page)).toHaveCount(0);
    expect(uploads).toBe(0);
  });
});
