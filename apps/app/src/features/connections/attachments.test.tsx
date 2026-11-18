import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_KEY } from "../../lib/access-token";
import {
  HOME_HEADING,
  jsonResponse,
  renderApp,
  SESSION_USER,
  withExpertsCatalog,
} from "../../test/render-app";
import type { ConnectionDto } from "./connection-messages";

const originalFetch = globalThis.fetch;
const TOKEN = "header.payload.signature";
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const CONNECTION_ID = "6d2f3c1a-9b7e-4d58-8a31-2c4e5f6a7b8c";

const connection = (overrides: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: CONNECTION_ID,
  name: "plano.pdf",
  kind: "pdf",
  sizeBytes: 1234,
  status: "processing",
  chunkCount: 0,
  errorCode: null,
  createdAt: "2026-11-17T12:00:00.000Z",
  ...overrides,
});

interface Call {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
}

/**
 * Answers the session and the catalog like the other home tests, hands every other call to
 * `handle` and records it, so a test can tell what was (and was not) sent.
 */
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
  // The composer stays disabled (and is rebuilt) until the stored conversation has loaded.
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: /^Message for the/ })).toBeEnabled(),
  );
}

const fileInput = () => screen.getByTestId("connection-file-input");
const pdf = (name = "plano.pdf") =>
  new File(["%PDF-1.4 content"], name, { type: "application/pdf" });
const findChip = async () =>
  within(await screen.findByRole("list", { name: "Attachments" })).getByRole("listitem");
const textbox = () => screen.getByRole("textbox", { name: /^Message for the/ });

beforeEach(() => {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, TOKEN);
  window.localStorage.setItem(PRIVACY_KEY, "true");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("the Add connection button (R1)", () => {
  it("is a button reachable by keyboard that opens the file picker for PDF, TXT, Markdown, JPG, PNG, MP3 and MP4", async () => {
    stubApi(() => jsonResponse(500, {}));

    const user = userEvent.setup();

    await openHome();

    const button = screen.getByRole("button", { name: "Add connection" });

    expect(fileInput()).toHaveAttribute("accept", ".pdf,.txt,.md,.jpg,.jpeg,.png,.mp3,.mp4");

    const clicked = vi.spyOn(fileInput(), "click");

    button.focus();
    await user.keyboard("{Enter}");

    expect(clicked).toHaveBeenCalledOnce();
  });

  it("turns the chosen file into a chip with the processing state", async () => {
    stubApi((call) =>
      isUpload(call)
        ? jsonResponse(202, { ...connection(), deduplicated: false })
        : jsonResponse(200, connection()),
    );

    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), pdf());

    const chip = await findChip();

    expect(within(chip).getByText("plano.pdf")).toBeInTheDocument();
    expect(within(chip).getByRole("status")).toHaveTextContent("Processing…");
  });
});

describe("sending is held back while a file processes (R8)", () => {
  it("disables Send until the connection is ready, then enables it", async () => {
    let statusCalls = 0;
    const calls = stubApi((call) => {
      if (isUpload(call)) {
        return jsonResponse(202, { ...connection(), deduplicated: false });
      }

      statusCalls += 1;

      return jsonResponse(200, connection({ status: "ready", chunkCount: 4 }));
    });
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "What does the plan say?");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();

    await user.upload(fileInput(), pdf());

    expect(await screen.findByText("Processing…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    // The first poll comes after about one second.
    expect(await screen.findByText("Ready", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(statusCalls).toBeGreaterThan(0);
    expect(calls.filter(isUpload)).toHaveLength(1);
  });

  it("lets the person remove a stuck attachment, which frees Send and never deletes the connection", async () => {
    const calls = stubApi((call) =>
      isUpload(call)
        ? jsonResponse(202, { ...connection(), deduplicated: false })
        : jsonResponse(200, connection()),
    );
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Hello");
    await user.upload(fileInput(), pdf());
    await screen.findByText("Processing…");

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Remove plano.pdf" }));

    expect(screen.queryByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(calls.every((call) => call.method === "GET" || isUpload(call))).toBe(true);
  });

  it("shows a deduplicated connection as ready at once, without waiting for a poll", async () => {
    stubApi((call) =>
      isUpload(call)
        ? jsonResponse(200, {
            ...connection({ status: "ready", chunkCount: 3 }),
            deduplicated: true,
          })
        : jsonResponse(200, connection({ status: "ready", chunkCount: 3 })),
    );

    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), pdf());

    expect(await screen.findByText("Ready")).toBeInTheDocument();
  });
});

describe("failures (R8)", () => {
  it("explains a PDF without text and Remove clears the chip, leaving the connection alone", async () => {
    const calls = stubApi((call) =>
      isUpload(call)
        ? jsonResponse(202, { ...connection(), deduplicated: false })
        : jsonResponse(200, connection({ status: "failed", errorCode: "NO_EXTRACTABLE_TEXT" })),
    );
    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), pdf("scan.pdf"));

    expect(
      await screen.findByText(
        "We couldn't find any text in this file. Scanned PDFs are not supported yet.",
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Try again/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove scan.pdf" }));

    expect(screen.queryByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("offers Try again for an unavailable provider and sends the same file again", async () => {
    let uploads = 0;
    const calls = stubApi((call) => {
      if (isUpload(call)) {
        uploads += 1;

        return jsonResponse(202, { ...connection(), deduplicated: false });
      }

      return jsonResponse(
        200,
        uploads < 2
          ? connection({ status: "failed", errorCode: "PROCESSING_UNAVAILABLE" })
          : connection({ status: "ready", chunkCount: 2 }),
      );
    });
    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), pdf());

    await user.click(
      await screen.findByRole("button", { name: "Try again with plano.pdf" }, { timeout: 4000 }),
    );

    expect(await screen.findByText("Ready", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(calls.filter(isUpload)).toHaveLength(2);
  });

  it("shows the message of a refused upload by its code", async () => {
    stubApi(() =>
      jsonResponse(400, {
        error: { code: "UNSUPPORTED_FILE", message: "Server text.", details: [] },
      }),
    );

    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), pdf("fake.pdf"));

    expect(
      await screen.findByText(
        "Only PDF, TXT, Markdown, JPG, PNG, MP3 and MP4 files are supported.",
      ),
    ).toBeInTheDocument();
  });

  it("does not upload a file the browser can already tell is wrong (too large)", async () => {
    const calls = stubApi(() => jsonResponse(500, {}));
    const user = userEvent.setup();
    const big = new File(["x"], "big.txt", { type: "text/plain" });

    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    await openHome();
    await user.upload(fileInput(), big);

    expect(await screen.findByText("Files can have at most 20 MB.")).toBeInTheDocument();
    expect(calls.filter(isUpload)).toHaveLength(0);
  });
});

describe("the privacy notice (R9)", () => {
  beforeEach(() => {
    window.localStorage.removeItem(PRIVACY_KEY);
  });

  it("asks before the first upload, and Cancel sends nothing", async () => {
    const calls = stubApi(() => jsonResponse(202, { ...connection(), deduplicated: false }));
    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), pdf());

    const dialog = await screen.findByRole("dialog", { name: "Before you connect a file" });

    expect(dialog).toHaveAccessibleDescription(/sent to an AI provider/);
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    expect(calls).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
    expect(calls).toEqual([]);
    expect(window.localStorage.getItem(PRIVACY_KEY)).toBeNull();
  });

  it("Escape also cancels", async () => {
    const calls = stubApi(() => jsonResponse(202, { ...connection(), deduplicated: false }));
    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), pdf());
    const dialog = await screen.findByRole("dialog");

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("uploads after the acceptance, remembers it and does not ask again", async () => {
    const calls = stubApi((call) =>
      isUpload(call)
        ? jsonResponse(202, { ...connection(), deduplicated: false })
        : jsonResponse(200, connection()),
    );
    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), pdf());
    await user.click(await screen.findByRole("button", { name: "I understand, continue" }));

    expect(await findChip()).toBeInTheDocument();
    await waitFor(() => expect(calls.filter(isUpload)).toHaveLength(1));
    expect(window.localStorage.getItem(PRIVACY_KEY)).toBe("true");

    await user.upload(fileInput(), pdf("second.pdf"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(calls.filter(isUpload)).toHaveLength(2));
  });
});

describe("images (spec 0026)", () => {
  const image = (name = "escalacao.png", type = "image/png") =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });
  const imageConnection = (overrides: Partial<ConnectionDto> = {}) =>
    connection({ name: "escalacao.png", kind: "image", ...overrides });

  it("accepts a PNG and a JPG as a chip with the processing state, then ready", async () => {
    const calls = stubApi((call) =>
      isUpload(call)
        ? jsonResponse(202, { ...imageConnection(), deduplicated: false })
        : jsonResponse(200, imageConnection({ status: "ready", chunkCount: 2 })),
    );
    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), image());
    await user.upload(fileInput(), image("foto.jpg", "image/jpeg"));

    expect(await screen.findByText("escalacao.png")).toBeInTheDocument();
    await waitFor(() => expect(calls.filter(isUpload)).toHaveLength(2));
    expect(await screen.findAllByText("Ready", {}, { timeout: 4000 })).not.toHaveLength(0);
  });

  it("does not upload an image above 10 MB, with the message of images", async () => {
    const calls = stubApi(() => jsonResponse(500, {}));
    const user = userEvent.setup();
    const big = image("big.png");

    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    await openHome();
    await user.upload(fileInput(), big);

    expect(await screen.findByText("Images can have at most 10 MB.")).toBeInTheDocument();
    expect(calls.filter(isUpload)).toHaveLength(0);
  });

  it("explains an image the API refused for its dimensions or size, by its code", async () => {
    stubApi((call) =>
      isUpload(call)
        ? jsonResponse(400, { error: { code: "IMAGE_TOO_LARGE", message: "x", details: [] } })
        : jsonResponse(500, {}),
    );

    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), image("huge.png"));

    expect(
      await screen.findByText("Images can have at most 8,000 pixels on each side."),
    ).toBeInTheDocument();
  });

  it("explains an image without content, with advice and no Try again", async () => {
    stubApi((call) =>
      isUpload(call)
        ? jsonResponse(202, { ...imageConnection(), deduplicated: false })
        : jsonResponse(
            200,
            imageConnection({ status: "failed", errorCode: "NO_EXTRACTABLE_TEXT" }),
          ),
    );

    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), image());

    expect(
      await screen.findByText(
        "We couldn't find any text or relevant content in this image. Send a clearer, well-lit image.",
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Try again/ })).not.toBeInTheDocument();
  });

  it("explains a refusal of the provider and offers Try again when it was unavailable", async () => {
    let code = "CONTENT_NOT_PROCESSABLE";

    stubApi((call) =>
      isUpload(call)
        ? jsonResponse(202, { ...imageConnection(), deduplicated: false })
        : jsonResponse(200, imageConnection({ status: "failed", errorCode: code })),
    );

    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), image());

    expect(
      await screen.findByText(
        "The AI provider couldn't process this image. Try another image.",
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Try again/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove escalacao.png" }));
    code = "PROCESSING_UNAVAILABLE";
    await user.upload(fileInput(), image("another.png"));

    expect(
      await screen.findByText(
        "We couldn't process this image right now. Try again in a moment.",
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Try again/ })).toBeInTheDocument();
  });

  it("tells in the privacy notice that images are sent to the AI provider too", async () => {
    window.localStorage.removeItem(PRIVACY_KEY);
    stubApi(() => jsonResponse(500, {}));

    const user = userEvent.setup();

    await openHome();
    await user.upload(fileInput(), image());

    const dialog = await screen.findByRole("dialog", { name: "Before you connect a file" });

    expect(dialog).toHaveAccessibleDescription(/Images are sent to the AI provider too/);
  });
});
