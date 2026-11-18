import { expect, test, type Page } from "@playwright/test";
import { buildMp3 } from "../apps/api/src/modules/connections/testing/media-fixtures";
import { query } from "./support/database";
import { ACCESS_TOKEN_KEY, seedSignedInUser } from "./support/session";

// The API under test runs with NODE_ENV=test: the media provider (Gemini), the embeddings and the
// chat model are the offline fakes (no network) and the chunks go to the local Weaviate, into the
// test collection. The messages endpoint is limited to 20 per minute per IP and the whole suite
// shares that quota, so the answer that cites a media is stored in the database like the server
// stores it (the streamed path is covered by the integration test) instead of being asked for.
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const PRIVACY_MEDIA_KEY = "rondo.connections.privacy-media-accepted";
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
  // The upload endpoint is limited to 20 per 10 minutes per IP and the whole suite shares that
  // quota (the suite already uses it all), so this spec uploads nothing: the media connection is
  // seeded as the API stores it once processed, and the upload, the long wait, the dedup and the
  // failures are covered by the integration and component tests.
  test("lists a video with its duration and shows the instant (mm:ss) in the source of a stored answer", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    const userId = await openHome(page, "media-video");
    const created = await query<{ id: string }>(
      `insert into public.connections
         (user_id, kind, name, size_bytes, duration_seconds, content_hash, status, chunk_count)
       values ($1, 'video', 'analysis.mp4', 4096, 480, $2, 'ready', 1) returning id`,
      [userId, "c".repeat(64)],
    );
    const connectionId = created.rows[0]?.id ?? "";

    await storeCitedAnswer(userId, connectionId, "analysis.mp4");
    await page.reload();
    await expect(textbox(page)).toBeEnabled();

    await expect(sources(page)).toBeVisible();
    await expect(sources(page)).toContainText("analysis.mp4 · 12:30");

    await page.getByRole("button", { name: "Your connections" }).click();

    const panel = page.getByRole("dialog", { name: "Connections" });

    await expect(panel).toBeVisible();
    await expect(panel.getByRole("listitem")).toContainText("Video · 4 KB · 08:00 · Ready");
    expect(consoleErrors).toEqual([]);
  });

  // The upload endpoint is limited to 20 per 10 minutes per IP and the whole suite shares that
  // quota, so the other cases of media (dedup, silent audio, refusals, limits) are covered by the
  // integration and component tests; this one is refused in the browser, with no upload.
  test("refuses a file of another audio format in the browser, with no upload", async ({
    page,
  }) => {
    let uploads = 0;

    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/connections")) {
        uploads += 1;
      }
    });
    await openHome(page, "media-errors");
    await attach(page, "talk.wav", "audio/wav", Buffer.from("RIFF....WAVEfmt  not an mp3"));

    await expect(
      page.getByText("Only PDF, TXT, Markdown, JPG, PNG, MP3 and MP4 files are supported."),
    ).toBeVisible();
    expect(uploads).toBe(0);
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
