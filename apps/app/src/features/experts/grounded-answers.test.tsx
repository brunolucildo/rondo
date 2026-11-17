import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_KEY } from "../../lib/access-token";
import {
  HOME_HEADING,
  jsonResponse,
  renderApp,
  SESSION_USER,
  storedConversations,
  storedMessage,
  withExpertsCatalog,
} from "../../test/render-app";
import type { ConnectionDto } from "../connections/connection-messages";
import type { Citation } from "./chat-state";

const originalFetch = globalThis.fetch;
const TOKEN = "header.payload.signature";
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const CONNECTION_ID = "6d2f3c1a-9b7e-4d58-8a31-2c4e5f6a7b8c";

const connection = (overrides: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: CONNECTION_ID,
  name: "plano.pdf",
  kind: "pdf",
  sizeBytes: 1234,
  status: "ready",
  chunkCount: 4,
  errorCode: null,
  createdAt: "2026-11-17T12:00:00.000Z",
  ...overrides,
});

const citation = (overrides: Partial<Citation> = {}): Citation => ({
  connectionId: CONNECTION_ID,
  sourceName: "plano.pdf",
  page: 2,
  position: 3,
  ...overrides,
});

function sse(...events: Array<[string, unknown]>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [event, data] of events) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** An answer that streams `text`, then reports the citations (when given), then `done`. */
const answer = (text: string, citations?: Citation[]) =>
  sse(
    ["delta", { text }],
    ...(citations === undefined ? [] : [["citations", { citations }] as [string, unknown]]),
    ["done", {}],
  );

const apiError = (status: number, code: string) =>
  jsonResponse(status, { error: { code, message: "Server message.", details: [] } });

interface Call {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
}

const isUpload = (call: Call) => call.method === "POST" && call.url.endsWith("/connections");
const isMessage = (call: Call) => call.url.endsWith("/messages");

/** Session and catalog as usual; every other call is recorded and answered by `handle`. */
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

  storedConversations.clear();
  vi.stubGlobal("fetch", withExpertsCatalog(fetchMock));

  return {
    calls,
    messages: () =>
      calls
        .filter(isMessage)
        .map((call) => JSON.parse(String(call.body)) as Record<string, unknown>),
  };
}

const textbox = () => screen.getByRole("textbox", { name: /^Message for the/ });
const fileInput = () => screen.getByTestId("connection-file-input");
const pdf = () => new File(["%PDF-1.4 content"], "plano.pdf", { type: "application/pdf" });
const log = () => screen.getByRole("log", { name: "Conversation" });

async function openHome() {
  renderApp("/app");

  await screen.findByRole("heading", { level: 1, name: HOME_HEADING });
  await screen.findByRole("combobox", { name: "Expert" });
  // The stored conversation loads first: the field is ready once it arrived.
  await waitFor(() => expect(textbox()).toBeEnabled());
}

/** Attaches a ready PDF (the upload answers a ready connection at once). */
async function attachReadyPdf(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(fileInput(), pdf());
  await screen.findByText("Ready");
}

beforeEach(() => {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, TOKEN);
  window.localStorage.setItem(PRIVACY_KEY, "true");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("the Sources of an answer (R9)", () => {
  it("lists each source with its name and page under the answer", async () => {
    stubApi(() =>
      answer("Plan says 40 minutes.", [
        citation(),
        citation({ sourceName: "notes.md", page: null, connectionId: "other", position: 0 }),
      ]),
    );

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "What is the load?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const sources = await screen.findByRole("region", { name: "Sources" });
    const items = within(sources).getAllByRole("listitem");

    expect(items.map((item) => item.textContent)).toEqual(["plano.pdf, page 2", "notes.md"]);
    expect(screen.queryByText("No connected source covers this.")).not.toBeInTheDocument();
    expect(within(log()).getByText("Plan says 40 minutes.")).toBeInTheDocument();
  });

  it("shows the notice and no list when no connected source covers the question", async () => {
    stubApi(() => answer("No connected source covers this question.", []));

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Who is the new striker?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("No connected source covers this.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sources" })).not.toBeInTheDocument();
  });

  it("shows neither the list nor the notice when no search ran", async () => {
    stubApi(() => answer("General answer."));

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await within(log()).findByText("General answer.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sources" })).not.toBeInTheDocument();
    expect(screen.queryByText("No connected source covers this.")).not.toBeInTheDocument();
  });

  it("shows the stored citations of the history, and the notice of a stored gap", async () => {
    stubApi(() => jsonResponse(500, {}));
    storedConversations.set("head-coach", () =>
      jsonResponse(200, {
        messages: [
          storedMessage(1, "user", "Question one"),
          { ...storedMessage(2, "assistant", "Answer one"), citations: [citation()] },
          storedMessage(3, "user", "Question two"),
          { ...storedMessage(4, "assistant", "Answer two"), citations: [] },
          storedMessage(5, "user", "Question three"),
          { ...storedMessage(6, "assistant", "Answer three"), citations: null },
        ],
        nextCursor: null,
      }),
    );

    await openHome();

    expect(await screen.findAllByRole("region", { name: "Sources" })).toHaveLength(1);
    expect(screen.getByText("plano.pdf, page 2")).toBeInTheDocument();
    expect(screen.getAllByText("No connected source covers this.")).toHaveLength(1);
  });
});

describe("the attached file travels with the message (R2, R9)", () => {
  function attachApi() {
    return stubApi((call) =>
      isUpload(call)
        ? jsonResponse(200, { ...connection(), deduplicated: true })
        : isMessage(call)
          ? answer("From your file.", [citation()])
          : jsonResponse(200, connection()),
    );
  }

  it("sends the id of the ready attachment as connectionIds, clears the chip, and later messages carry none", async () => {
    const api = attachApi();
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "First question");
    await attachReadyPdf(user);
    await user.click(screen.getByRole("button", { name: "Send" }));

    await within(log()).findByText("From your file.");
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Attachments" })).not.toBeInTheDocument(),
    );

    await user.type(textbox(), "Second question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.messages()).toHaveLength(2));

    expect(api.messages()[0]).toEqual({
      content: "First question",
      connectionIds: [CONNECTION_ID],
    });
    expect(api.messages()[1]).toEqual({ content: "Second question" });
  });

  it("sends a deduplicated file once, even when it was attached twice", async () => {
    const api = attachApi();
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Question");
    await attachReadyPdf(user);
    await user.upload(
      fileInput(),
      new File(["%PDF-1.4 content"], "copy.pdf", { type: "application/pdf" }),
    );
    await waitFor(() => expect(screen.getAllByText("Ready")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Send" }));

    await within(log()).findByText("From your file.");

    expect(api.messages()[0]?.connectionIds).toEqual([CONNECTION_ID]);
  });

  it("does not send the message when the server says the file is gone: the chip explains, the text comes back and Send waits for Remove", async () => {
    const api = stubApi((call) =>
      isUpload(call)
        ? jsonResponse(200, { ...connection(), deduplicated: true })
        : isMessage(call)
          ? apiError(404, "CONNECTION_NOT_FOUND")
          : jsonResponse(200, connection()),
    );
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "About the file");
    await attachReadyPdf(user);
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText("This file is no longer available. Remove it and attach it again."),
    ).toBeInTheDocument();
    expect(within(log()).queryByText("About the file")).not.toBeInTheDocument();
    expect(textbox()).toHaveValue("About the file");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(api.messages()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Remove plano.pdf" }));

    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("explains a file that is not ready yet (409) the same way", async () => {
    stubApi((call) =>
      isUpload(call)
        ? jsonResponse(200, { ...connection(), deduplicated: true })
        : isMessage(call)
          ? apiError(409, "CONNECTION_NOT_READY")
          : jsonResponse(200, connection()),
    );

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "About the file");
    await attachReadyPdf(user);
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText(
        "This file is not ready yet. Remove it or wait a moment and try again.",
      ),
    ).toBeInTheDocument();
  });
});

describe("when the sources cannot be searched (R8)", () => {
  it("shows the error with Try again, which asks again with the same files", async () => {
    let attempts = 0;
    const api = stubApi((call) => {
      if (isUpload(call)) {
        return jsonResponse(200, { ...connection(), deduplicated: true });
      }

      if (isMessage(call)) {
        attempts += 1;

        return attempts === 1
          ? sse([
              "error",
              {
                code: "KNOWLEDGE_UNAVAILABLE",
                message: "We couldn't search your sources right now.",
              },
            ])
          : answer("Now from the file.", [citation()]);
      }

      return jsonResponse(200, connection());
    });
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "About the file");
    await attachReadyPdf(user);
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText("We couldn't search your sources right now."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await within(log()).findByText("Now from the file.")).toBeInTheDocument();
    expect(api.messages()).toEqual([
      { content: "About the file", connectionIds: [CONNECTION_ID] },
      { content: "About the file", connectionIds: [CONNECTION_ID] },
    ]);
    expect(within(log()).getAllByText("About the file")).toHaveLength(1);
  });
});
