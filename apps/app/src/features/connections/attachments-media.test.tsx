import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_KEY } from "../../lib/access-token";
import { ApiError } from "../../lib/api-client";
import {
  HOME_HEADING,
  jsonResponse,
  renderApp,
  SESSION_USER,
  withExpertsCatalog,
} from "../../test/render-app";
import {
  checkFileBeforeUpload,
  type ConnectionDto,
  describeProcessingFailure,
  describeUploadFailure,
  formatTimestamp,
  mediaKindOfFile,
} from "./connection-messages";

const originalFetch = globalThis.fetch;
const TOKEN = "header.payload.signature";
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const PRIVACY_MEDIA_KEY = "rondo.connections.privacy-media-accepted";
const MB = 1024 * 1024;

const media = (
  id: string,
  name: string,
  overrides: Partial<ConnectionDto> = {},
): ConnectionDto => ({
  id,
  name,
  kind: name.endsWith(".mp3") ? "audio" : "video",
  sizeBytes: 4096,
  durationSeconds: 480,
  status: "processing",
  chunkCount: 0,
  errorCode: null,
  createdAt: "2026-11-18T12:00:00.000Z",
  ...overrides,
});

interface Call {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
}

function stubApi(handle: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = String(input);

    if (url.endsWith("/auth/session")) {
      return Promise.resolve(jsonResponse(200, { user: SESSION_USER }));
    }

    const call: Call = { url, method: init?.method ?? "GET", body: init?.body };

    calls.push(call);

    return Promise.resolve(handle(call));
  });

  vi.stubGlobal("fetch", withExpertsCatalog(fetchMock));

  return calls;
}

const isUpload = (call: Call) => call.method === "POST" && call.url.endsWith("/connections");

async function openHome() {
  renderApp("/app");

  await screen.findByRole("heading", { level: 1, name: HOME_HEADING });
  await screen.findByRole("combobox", { name: "Expert" });
  // The stored conversation loads first and rebuilds the composer: wait for it to be enabled.
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: /^Message for the/ })).toBeEnabled(),
  );
}

const fileInput = () => screen.getByTestId("connection-file-input");
const mp3 = (name = "talk.mp3") => new File(["ID3 audio"], name, { type: "audio/mpeg" });
const mp4 = (name = "match.mp4") => new File(["....ftypisom"], name, { type: "video/mp4" });
const chips = () => screen.getByRole("list", { name: "Attachments" });

beforeEach(() => {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, TOKEN);
  window.localStorage.setItem(PRIVACY_KEY, "true");
  window.localStorage.setItem(PRIVACY_MEDIA_KEY, "true");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("attaching an audio or a video (spec 0028)", () => {
  it("accepts .mp3 and .mp4 in the picker and shows the long wait message while it processes", async () => {
    stubApi((call) =>
      isUpload(call)
        ? jsonResponse(202, { ...media("a1", "match.mp4"), deduplicated: false })
        : jsonResponse(200, media("a1", "match.mp4")),
    );

    const user = userEvent.setup();

    await openHome();
    expect(fileInput().getAttribute("accept")).toContain(".mp3");
    expect(fileInput().getAttribute("accept")).toContain(".mp4");

    await user.upload(fileInput(), mp4());

    const chip = within(chips()).getByRole("listitem");

    expect(await within(chip).findByText("Processing…")).toBeInTheDocument();
    expect(within(chip).getByText("This can take a few minutes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("asks for the media notice first, even after the notice of documents, and uploads nothing on Cancel", async () => {
    window.localStorage.removeItem(PRIVACY_MEDIA_KEY);

    const calls = stubApi(() => jsonResponse(500, {}));
    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), mp3());

    const dialog = await screen.findByRole("dialog", { name: "Before you connect a file" });

    expect(dialog).toHaveTextContent("voice and the image of people");
    expect(dialog).toHaveTextContent("Google Gemini");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(calls.filter(isUpload)).toHaveLength(0);
    expect(screen.queryByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
  });

  it("remembers the media notice and does not show the media text for a document", async () => {
    window.localStorage.removeItem(PRIVACY_MEDIA_KEY);
    window.localStorage.removeItem(PRIVACY_KEY);

    stubApi((call) =>
      isUpload(call)
        ? jsonResponse(202, { ...media("a1", "talk.mp3"), deduplicated: false })
        : jsonResponse(200, media("a1", "talk.mp3")),
    );

    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), new File(["# notes"], "notes.md", { type: "text/markdown" }));

    const documentNotice = await screen.findByRole("dialog", { name: "Before you connect a file" });

    expect(documentNotice).not.toHaveTextContent("Gemini");
    await user.click(within(documentNotice).getByRole("button", { name: "Cancel" }));

    await user.upload(fileInput(), mp3());
    await user.click(await screen.findByRole("button", { name: "I understand, continue" }));

    expect(window.localStorage.getItem(PRIVACY_MEDIA_KEY)).toBe("true");
    expect(window.localStorage.getItem(PRIVACY_KEY)).toBe("true");
    expect(await within(chips()).findByText("Processing…")).toBeInTheDocument();
  });

  it("sends only two media at once; the third waits for its turn and goes when one is ready", async () => {
    const answers: Record<string, ConnectionDto> = {
      one: media("m1", "one.mp3"),
      two: media("m2", "two.mp3"),
      three: media("m3", "three.mp3"),
    };
    let firstSettled = false;
    const calls = stubApi((call) => {
      if (isUpload(call)) {
        const name = (call.body as FormData).get("file") as File;
        const key = name.name.replace(".mp3", "");

        return jsonResponse(202, { ...answers[key], deduplicated: false });
      }

      if (call.url.endsWith("/connections/m1")) {
        firstSettled = true;

        return jsonResponse(200, media("m1", "one.mp3", { status: "ready", chunkCount: 2 }));
      }

      return jsonResponse(200, answers.two);
    });
    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), mp3("one.mp3"));
    await user.upload(fileInput(), mp3("two.mp3"));
    await user.upload(fileInput(), mp3("three.mp3"));

    expect(await screen.findByText("Waiting for its turn…")).toBeInTheDocument();
    expect(calls.filter(isUpload)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    // The first poll of a media comes after about 2 seconds; then the slot is free.
    await waitFor(() => expect(calls.filter(isUpload)).toHaveLength(3), { timeout: 8000 });

    expect(firstSettled).toBe(true);
    expect(screen.queryByText("Waiting for its turn…")).not.toBeInTheDocument();
  }, 15_000);

  it("does not upload a file that the browser already knows is too large for its type", async () => {
    const calls = stubApi(() => jsonResponse(500, {}));
    const user = userEvent.setup();

    await openHome();

    const big = mp3("big.mp3");

    Object.defineProperty(big, "size", { value: 51 * MB });
    await user.upload(fileInput(), big);

    expect(await screen.findByText("MP3 files can have at most 50 MB.")).toBeInTheDocument();
    expect(calls.filter(isUpload)).toHaveLength(0);
  });
});

describe("the messages of audio and video", () => {
  const apiError = (status: number, code: string) =>
    new ApiError(status, code, "Server message.", []);

  it.each([
    ["MEDIA_TOO_LONG", "Audio can have at most 60 minutes and video at most 20 minutes.", false],
    [
      "TOO_MANY_PROCESSING",
      "You already have 2 audio or video files being processed. Wait for one to finish.",
      true,
    ],
    [
      "MEDIA_DAILY_LIMIT",
      "You reached the daily limit of 100 minutes of audio and video. Try again tomorrow.",
      false,
    ],
    ["MEDIA_UNAVAILABLE", "Audio and video are not available right now.", true],
    [
      "MEDIA_UNREADABLE",
      "We couldn't read the length of this file. Export it again and try again.",
      false,
    ],
  ] as const)("explains %s", (code, text, retryable) => {
    expect(describeUploadFailure(apiError(400, code))).toEqual({ text, retryable });
  });

  it("explains each failure of a media connection, and keeps the PDF wording for PDFs", () => {
    expect(describeProcessingFailure("NO_EXTRACTABLE_TEXT", "audio").text).toMatch(
      /speech or content/,
    );
    expect(describeProcessingFailure("NO_EXTRACTABLE_TEXT", "pdf").text).toMatch(/Scanned PDFs/);
    expect(describeProcessingFailure("NO_EXTRACTABLE_TEXT").text).toMatch(/Scanned PDFs/);
    expect(describeProcessingFailure("MEDIA_UNREADABLE", "video")).toMatchObject({
      retryable: false,
    });
    expect(describeProcessingFailure("CONTENT_NOT_PROCESSABLE", "video")).toMatchObject({
      retryable: false,
    });
    expect(describeProcessingFailure("PROCESSING_UNAVAILABLE", "video").retryable).toBe(true);
  });

  it("checks the size by type before uploading", () => {
    const file = (name: string, size: number) => ({ name, size }) as File;

    expect(checkFileBeforeUpload(file("a.mp3", 50 * MB))).toBeNull();
    expect(checkFileBeforeUpload(file("a.mp3", 50 * MB + 1))?.text).toBe(
      "MP3 files can have at most 50 MB.",
    );
    expect(checkFileBeforeUpload(file("a.mp4", 200 * MB))).toBeNull();
    expect(checkFileBeforeUpload(file("a.mp4", 200 * MB + 1))?.text).toBe(
      "MP4 files can have at most 200 MB.",
    );
    expect(checkFileBeforeUpload(file("a.pdf", 20 * MB + 1))?.text).toBe(
      "Files can have at most 20 MB.",
    );
    expect(checkFileBeforeUpload(file("a.wav", 10))?.text).toBe(
      "Only PDF, TXT, Markdown, MP3 and MP4 files are supported.",
    );
    expect(mediaKindOfFile({ name: "Clip.MP4" })).toBe("video");
    expect(mediaKindOfFile({ name: "notes.md" })).toBeNull();
  });

  it("formats the instant as mm:ss, with hours from an hour on", () => {
    expect(formatTimestamp(750)).toBe("12:30");
    expect(formatTimestamp(5)).toBe("00:05");
    expect(formatTimestamp(3600)).toBe("1:00:00");
    expect(formatTimestamp(3723)).toBe("1:02:03");
    expect(formatTimestamp(-4)).toBe("00:00");
  });
});
