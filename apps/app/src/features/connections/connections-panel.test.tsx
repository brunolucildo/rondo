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
import type { ConnectionDto } from "./connection-messages";

const originalFetch = globalThis.fetch;
const TOKEN = "header.payload.signature";
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const FIRST_ID = "6d2f3c1a-9b7e-4d58-8a31-2c4e5f6a7b8c";
const SECOND_ID = "7e3a4d2b-0c8f-4e69-9b42-3d5f6a7b8c9d";

const connection = (overrides: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: FIRST_ID,
  name: "plano.pdf",
  kind: "pdf",
  sizeBytes: 1234,
  status: "ready",
  chunkCount: 4,
  errorCode: null,
  createdAt: "2026-11-17T12:00:00.000Z",
  ...overrides,
});

const second = () =>
  connection({
    id: SECOND_ID,
    name: "notas.md",
    kind: "md",
    sizeBytes: 2 * 1024 * 1024,
    createdAt: "2026-11-16T12:00:00.000Z",
  });

const apiError = (status: number, code: string) =>
  jsonResponse(status, { error: { code, message: "Server message.", details: [] } });

interface Call {
  url: string;
  method: string;
}

/** The session and the catalog as usual; the other calls are recorded and answered by `handle`. */
function stubApi(handle: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = String(input);

    if (url.endsWith("/auth/session")) {
      return Promise.resolve(jsonResponse(200, { user: SESSION_USER }));
    }

    const call: Call = { url, method: init?.method ?? "GET" };

    calls.push(call);

    return Promise.resolve(handle(call));
  });

  storedConversations.clear();
  vi.stubGlobal("fetch", withExpertsCatalog(fetchMock));

  return calls;
}

const isList = (call: Call) => call.method === "GET" && call.url.endsWith("/connections");
const isDelete = (call: Call) => call.method === "DELETE";
const deletes = (calls: Call[]) =>
  calls.filter(isDelete).map((call) => call.url.split("/api/v1")[1]);

/** A server that keeps a list: `GET` answers it and `DELETE` removes from it. */
function serverWith(initial: ConnectionDto[], onDelete?: (call: Call) => Response | undefined) {
  let current = [...initial];

  return (call: Call): Response => {
    if (isList(call)) {
      return jsonResponse(200, { connections: current });
    }

    if (isDelete(call)) {
      const custom = onDelete?.(call);

      if (custom !== undefined) {
        return custom;
      }

      const id = call.url.split("/").pop();

      current = call.url.endsWith("/connections") ? [] : current.filter((item) => item.id !== id);

      return new Response(null, { status: 204 });
    }

    return jsonResponse(500, {});
  };
}

async function openHome() {
  renderApp("/app");

  await screen.findByRole("heading", { level: 1, name: HOME_HEADING });
  await screen.findByRole("combobox", { name: "Expert" });
  // The composer stays disabled (and is rebuilt) until the stored conversation has loaded.
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: /^Message for the/ })).toBeEnabled(),
  );
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await openHome();
  await user.click(screen.getByRole("button", { name: "Your connections" }));

  return screen.findByRole("dialog", { name: "Connections" });
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

describe("the panel of connections (R8)", () => {
  it("lists the connections with name, type, size, status and date, in the order the server gave", async () => {
    stubApi(serverWith([connection(), second()]));

    const user = userEvent.setup();
    const panel = await openPanel(user);
    const list = await within(panel).findByRole("list", { name: "Your connections" });
    const [first, other] = within(list).getAllByRole("listitem");

    expect(within(panel).getByRole("heading", { name: "Add" })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Your connections" })).toBeInTheDocument();
    expect(first).toHaveTextContent("plano.pdf");
    expect(first).toHaveTextContent("PDF · 1 KB · Ready · Nov 17, 2026");
    expect(other).toHaveTextContent("notas.md");
    expect(other).toHaveTextContent("Markdown · 2.0 MB · Ready · Nov 16, 2026");
  });

  it("shows the type and the duration of an audio and a video (spec 0028)", async () => {
    stubApi(
      serverWith([
        connection({ id: FIRST_ID, name: "analysis.mp4", kind: "video", durationSeconds: 750 }),
        connection({ id: SECOND_ID, name: "talk.mp3", kind: "audio", durationSeconds: 3723 }),
      ]),
    );

    const user = userEvent.setup();
    const panel = await openPanel(user);
    const list = await within(panel).findByRole("list", { name: "Your connections" });
    const [video, audio] = within(list).getAllByRole("listitem");

    expect(video).toHaveTextContent("Video · 1 KB · 12:30 · Ready · Nov 17, 2026");
    expect(audio).toHaveTextContent("Audio · 1 KB · 1:02:03 · Ready · Nov 17, 2026");
  });

  it("explains a silent media and an unreadable one with words that fit audio and video", async () => {
    stubApi(
      serverWith([
        connection({
          id: FIRST_ID,
          kind: "video",
          name: "quiet.mp4",
          status: "failed",
          errorCode: "NO_EXTRACTABLE_TEXT",
        }),
        connection({
          id: SECOND_ID,
          kind: "audio",
          name: "broken.mp3",
          status: "failed",
          errorCode: "MEDIA_UNREADABLE",
        }),
      ]),
    );

    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(
      await within(panel).findByText(/couldn't find any speech or content/),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/Scanned PDFs/)).not.toBeInTheDocument();
    expect(within(panel).getByText(/couldn't read this audio or video/)).toBeInTheDocument();
  });

  it("explains why a connection failed", async () => {
    stubApi(serverWith([connection({ status: "failed", errorCode: "PDF_PROTECTED" })]));

    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(await within(panel).findByText(/protected by a password/)).toBeInTheDocument();
  });

  it("shows the loading state, then the empty state with a shortcut to add a file", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const serve = serverWith([]);

    storedConversations.clear();

    const slow = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);

      if (url.endsWith("/auth/session")) {
        return Promise.resolve(jsonResponse(200, { user: SESSION_USER }));
      }

      const call: Call = { url, method: init?.method ?? "GET" };

      return isList(call) ? gate.then(() => serve(call)) : Promise.resolve(serve(call));
    });

    vi.stubGlobal("fetch", withExpertsCatalog(slow));

    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(within(panel).getByText("Loading your connections…")).toBeInTheDocument();

    release();

    expect(await within(panel).findByText("No connections yet")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Delete all" })).not.toBeInTheDocument();

    const clicked = vi.spyOn(screen.getByTestId("panel-file-input"), "click");

    await user.click(within(panel).getByRole("button", { name: "Add a file" }));

    expect(clicked).toHaveBeenCalledOnce();
  });

  it("shows an error with Try again when the list cannot be loaded", async () => {
    let failing = true;
    const serve = serverWith([connection()]);

    stubApi((call) => (isList(call) && failing ? apiError(500, "INTERNAL_ERROR") : serve(call)));

    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(
      await within(panel).findByText("We couldn't load your connections."),
    ).toBeInTheDocument();

    failing = false;
    await user.click(within(panel).getByRole("button", { name: "Try again" }));

    expect(await within(panel).findByText("plano.pdf")).toBeInTheDocument();
  });

  it("deletes one connection after the confirmation, which names it and warns it cannot be undone", async () => {
    const calls = stubApi(serverWith([connection(), second()]));
    const user = userEvent.setup();
    const panel = await openPanel(user);

    await user.click(await within(panel).findByRole("button", { name: "Delete plano.pdf" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete this connection?" });

    expect(dialog).toHaveTextContent('"plano.pdf"');
    expect(dialog).toHaveTextContent("can't be undone");
    expect(dialog).toHaveTextContent("Source removed");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    expect(deletes(calls)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Delete connection" }));

    await waitFor(() =>
      expect(within(panel).queryByRole("button", { name: "Delete plano.pdf" })).toBeNull(),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deletes(calls)).toEqual([`/connections/${FIRST_ID}`]);
    expect(within(panel).getByText("notas.md")).toBeInTheDocument();
  });

  it("changes nothing when the confirmation is cancelled, by button or by Escape", async () => {
    const calls = stubApi(serverWith([connection()]));
    const user = userEvent.setup();
    const panel = await openPanel(user);
    const opener = await within(panel).findByRole("button", { name: "Delete plano.pdf" });

    await user.click(opener);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());

    await user.click(opener);
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // Escape closed only the confirmation: the panel is still there.
    expect(screen.getByRole("dialog", { name: "Connections" })).toBeInTheDocument();
    expect(deletes(calls)).toEqual([]);
    expect(within(panel).getByText("plano.pdf")).toBeInTheDocument();
  });

  it("keeps the row and offers Try again when the index is unavailable (503)", async () => {
    let failing = true;
    const calls = stubApi(
      serverWith([connection()], () =>
        failing ? apiError(503, "KNOWLEDGE_UNAVAILABLE") : undefined,
      ),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    await user.click(await within(panel).findByRole("button", { name: "Delete plano.pdf" }));

    const dialog = await screen.findByRole("alertdialog");

    await user.click(within(dialog).getByRole("button", { name: "Delete connection" }));

    expect(
      await within(dialog).findByText("We couldn't delete this connection. Try again."),
    ).toBeInTheDocument();
    expect(within(panel).getByText("plano.pdf")).toBeInTheDocument();

    failing = false;
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(deletes(calls)).toHaveLength(2);
    await waitFor(() => expect(within(panel).queryByText("plano.pdf")).toBeNull());
  });

  it("says to wait when the connection is still processing (409)", async () => {
    stubApi(serverWith([connection()], () => apiError(409, "CONNECTION_PROCESSING")));

    const user = userEvent.setup();
    const panel = await openPanel(user);

    await user.click(await within(panel).findByRole("button", { name: "Delete plano.pdf" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete connection",
      }),
    );

    expect(await screen.findByText("Wait for it to finish.")).toBeInTheDocument();
    expect(within(panel).getByText("plano.pdf")).toBeInTheDocument();
  });

  it("reloads the list when the connection was already removed elsewhere (404)", async () => {
    const calls = stubApi(serverWith([connection()], () => apiError(404, "CONNECTION_NOT_FOUND")));
    const user = userEvent.setup();
    const panel = await openPanel(user);

    await user.click(await within(panel).findByRole("button", { name: "Delete plano.pdf" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete connection",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    // The list was fetched again after the 404.
    await waitFor(() => expect(calls.filter(isList).length).toBeGreaterThanOrEqual(2));
  });

  it("deletes all after a confirmation that cites the quantity and the warning", async () => {
    const calls = stubApi(serverWith([connection(), second()]));
    const user = userEvent.setup();
    const panel = await openPanel(user);

    await user.click(await within(panel).findByRole("button", { name: "Delete all" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete all 2 connections?" });

    expect(dialog).toHaveTextContent("All 2 of your connections");
    expect(dialog).toHaveTextContent("can't be undone");
    expect(deletes(calls)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Delete all" }));

    expect(await within(panel).findByText("No connections yet")).toBeInTheDocument();
    expect(deletes(calls)).toEqual(["/connections"]);
  });

  it("closes with Escape and the Close button, and keeps Tab inside the panel", async () => {
    stubApi(serverWith([connection()]));

    const user = userEvent.setup();
    const panel = await openPanel(user);

    await within(panel).findByText("plano.pdf");
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Close" })).toHaveFocus());

    for (let step = 0; step < 8; step += 1) {
      await user.tab();
      expect(panel).toContainElement(document.activeElement as HTMLElement);
    }

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Connections" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Your connections" })).toHaveFocus(),
    );
  });

  it("closes the panel and attaches the file chosen in the Add section", async () => {
    stubApi((call) =>
      call.method === "POST"
        ? jsonResponse(202, { ...connection({ status: "processing" }), deduplicated: false })
        : serverWith([])(call),
    );

    const user = userEvent.setup();

    await openPanel(user);
    await user.upload(
      screen.getByTestId("panel-file-input"),
      new File(["%PDF-1.4 content"], "plano.pdf", { type: "application/pdf" }),
    );

    expect(screen.queryByRole("dialog", { name: "Connections" })).not.toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Attachments" })).toBeInTheDocument();
  });
});

describe("sources of deleted connections (R7)", () => {
  const citation = (id: string, sourceName: string, page: number | null) => ({
    connectionId: id,
    sourceName,
    page,
    position: 0,
  });

  it("reads 'Source removed' without the name, and the other sources keep theirs", async () => {
    stubApi(serverWith([]));
    storedConversations.set("head-coach", () =>
      jsonResponse(200, {
        messages: [
          storedMessage(1, "user", "A question"),
          {
            ...storedMessage(2, "assistant", "The answer stays."),
            citations: [
              { ...citation(FIRST_ID, "plano.pdf", 2), removed: false },
              { connectionId: SECOND_ID, removed: true },
              { connectionId: SECOND_ID, removed: true },
            ],
          },
        ],
        nextCursor: null,
      }),
    );

    await openHome();

    const sources = await screen.findByRole("region", { name: "Sources" });

    expect(screen.getByText("The answer stays.")).toBeInTheDocument();
    expect(
      within(sources)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["plano.pdf, page 2", "Source removed"]);
  });

  it("turns the sources on screen into 'Source removed' as soon as the connection is deleted", async () => {
    const calls = stubApi(serverWith([connection()]));
    storedConversations.set("head-coach", () =>
      jsonResponse(200, {
        messages: [
          storedMessage(1, "user", "A question"),
          {
            ...storedMessage(2, "assistant", "The answer stays."),
            citations: [{ ...citation(FIRST_ID, "plano.pdf", 2), removed: false }],
          },
        ],
        nextCursor: null,
      }),
    );

    const user = userEvent.setup();

    await openHome();

    const sources = await screen.findByRole("region", { name: "Sources" });

    expect(sources).toHaveTextContent("plano.pdf, page 2");

    await user.click(screen.getByRole("button", { name: "Your connections" }));
    await user.click(await screen.findByRole("button", { name: "Delete plano.pdf" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete connection",
      }),
    );
    await waitFor(() => expect(deletes(calls)).toHaveLength(1));
    await user.click(await screen.findByRole("button", { name: "Close" }));

    await waitFor(() => expect(sources).toHaveTextContent("Source removed"));
    expect(sources).not.toHaveTextContent("plano.pdf");
    expect(screen.getByText("The answer stays.")).toBeInTheDocument();
  });
});
