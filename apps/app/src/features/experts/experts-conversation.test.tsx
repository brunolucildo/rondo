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
  stubSessionFetch,
} from "../../test/render-app";

const originalFetch = globalThis.fetch;
const originalScrollIntoView = Element.prototype.scrollIntoView;
const TOKEN = "header.payload.signature";

const sessionOk = () => jsonResponse(200, { user: SESSION_USER });
const noContent = () => new Response(null, { status: 204 });

function apiError(status: number, code: string): Response {
  return jsonResponse(status, { error: { code, message: "Server message.", details: [] } });
}

const storedConversation =
  (...messages: ReturnType<typeof storedMessage>[]) =>
  () =>
    jsonResponse(200, { messages, nextCursor: null });

const textbox = () => screen.getByRole("textbox", { name: /^Message for the/ });
const deletes = (fetchMock: ReturnType<typeof stubSessionFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");

async function openHome() {
  renderApp("/app");

  await screen.findByRole("heading", { level: 1, name: HOME_HEADING });
  await screen.findByRole("combobox", { name: "Expert" });
  // The stored conversation loads first: the field is ready once it arrived.
  await waitFor(() => expect(textbox()).toBeEnabled());
}

beforeEach(() => {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, TOKEN);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe("the stored conversation (R9)", () => {
  it("shows a loading status, then the stored messages in order, with the last one in view", async () => {
    let release: (response: Response) => void = () => undefined;
    const scrollIntoView = vi.fn();

    Element.prototype.scrollIntoView = scrollIntoView;
    stubSessionFetch(sessionOk);
    storedConversations.set(
      "head-coach",
      () => new Promise<Response>((resolve) => (release = resolve)) as never,
    );
    renderApp("/app");

    expect(await screen.findByText("Loading the conversation…")).toBeInTheDocument();
    expect(textbox()).toBeDisabled();

    release(
      storedConversation(
        storedMessage(1, "user", "Pergunta antiga"),
        storedMessage(2, "assistant", "Resposta antiga"),
        storedMessage(3, "user", "Última pergunta"),
        storedMessage(4, "assistant", "Última resposta"),
      )(),
    );

    const log = await screen.findByRole("log", { name: "Conversation" });

    expect(await within(log).findByText("Última resposta")).toBeInTheDocument();
    expect(
      within(log)
        .getAllByText(/pergunta|resposta/i)
        .map((node) => node.textContent),
    ).toEqual(["Pergunta antiga", "Resposta antiga", "Última pergunta", "Última resposta"]);
    expect(screen.queryByRole("heading", { level: 2, name: "Head Coach" })).not.toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.queryByText("Loading the conversation…")).not.toBeInTheDocument();
  });

  it("shows the suggestions when there is no stored conversation", async () => {
    stubSessionFetch(sessionOk);
    await openHome();

    expect(screen.getByRole("heading", { level: 2, name: "Head Coach" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear conversation" })).not.toBeInTheDocument();
  });

  it("marks a stored incomplete answer and offers Try again", async () => {
    stubSessionFetch(sessionOk);
    storedConversations.set(
      "head-coach",
      storedConversation(
        storedMessage(1, "user", "Pergunta"),
        storedMessage(2, "assistant", "Resposta pela me", "incomplete"),
      ),
    );

    await openHome();

    expect(screen.getByText("Resposta pela me")).toBeInTheDocument();
    expect(screen.getByText("Incomplete answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows the conversation of the other expert when the dropdown changes, asking the server for each", async () => {
    stubSessionFetch(sessionOk);

    const reads: string[] = [];
    const base = globalThis.fetch;

    storedConversations.set(
      "head-coach",
      storedConversation(storedMessage(1, "user", "Conversa do técnico")),
    );
    storedConversations.set(
      "physiologist",
      storedConversation(storedMessage(1, "user", "Conversa da fisiologia")),
    );
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/conversation")) {
        reads.push(String(input));
      }

      return base(input, init);
    });

    const user = userEvent.setup();

    await openHome();

    expect(screen.getByText("Conversa do técnico")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Expert" }), "physiologist");

    expect(await screen.findByText("Conversa da fisiologia")).toBeInTheDocument();
    expect(screen.queryByText("Conversa do técnico")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Expert" }), "head-coach");

    expect(await screen.findByText("Conversa do técnico")).toBeInTheDocument();
    expect(reads.map((url) => /experts\/([^/]+)\//.exec(url)?.[1])).toEqual([
      "head-coach",
      "physiologist",
      "head-coach",
    ]);
  });

  it("cancels the read of the previous expert when the dropdown changes", async () => {
    stubSessionFetch(sessionOk);

    const signals: Array<AbortSignal | null | undefined> = [];
    const base = globalThis.fetch;

    storedConversations.set("head-coach", () => new Promise<Response>(() => undefined) as never);
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/head-coach/conversation")) {
        signals.push(init?.signal);
      }

      return base(input, init);
    });

    const user = userEvent.setup();

    renderApp("/app");
    await screen.findByText("Loading the conversation…");
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Expert" }),
      "physiologist",
    );

    expect(signals[0]?.aborted).toBe(true);
    expect(
      await screen.findByRole("heading", { level: 2, name: "Physiologist" }),
    ).toBeInTheDocument();
  });

  it("shows an error with Try again when the conversation cannot be loaded, and recovers", async () => {
    stubSessionFetch(sessionOk);

    let attempts = 0;

    storedConversations.set("head-coach", () => {
      attempts += 1;

      return attempts === 1
        ? apiError(500, "INTERNAL_ERROR")
        : storedConversation(storedMessage(1, "user", "Voltou"))();
    });

    const user = userEvent.setup();

    renderApp("/app");

    expect(await screen.findByText("We couldn't load the conversation.")).toBeInTheDocument();
    expect(textbox()).toBeDisabled();
    // The dropdown still works while the conversation failed.
    expect(screen.getByRole("combobox", { name: "Expert" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Voltou")).toBeInTheDocument();
  });
});

describe("Clear conversation (R7)", () => {
  const withStoredConversation = () =>
    storedConversations.set(
      "head-coach",
      storedConversation(
        storedMessage(1, "user", "Pergunta"),
        storedMessage(2, "assistant", "Resposta"),
      ),
    );

  it("asks for confirmation, deletes with DELETE and shows the empty state", async () => {
    const fetchMock = stubSessionFetch(sessionOk, noContent);

    withStoredConversation();

    const user = userEvent.setup();

    await openHome();
    await user.click(screen.getByRole("button", { name: "Clear conversation" }));

    const dialog = screen.getByRole("alertdialog", { name: "Clear this conversation?" });

    expect(dialog).toHaveAccessibleDescription(/can't be undone/);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(deletes(fetchMock)).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Delete conversation" }));

    expect(
      await screen.findByRole("heading", { level: 2, name: "Head Coach" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Resposta")).not.toBeInTheDocument();
    expect(deletes(fetchMock)).toHaveLength(1);
    expect(String(deletes(fetchMock)[0]?.[0])).toMatch(/\/experts\/head-coach\/conversation$/);
  });

  it("changes nothing when the confirmation is cancelled, by button or by Escape, and returns the focus", async () => {
    const fetchMock = stubSessionFetch(sessionOk);

    withStoredConversation();

    const user = userEvent.setup();

    await openHome();
    await user.click(screen.getByRole("button", { name: "Clear conversation" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear conversation" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Clear conversation" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Resposta")).toBeInTheDocument();
    expect(deletes(fetchMock)).toHaveLength(0);
  });

  it("keeps the conversation and offers Try again when the delete fails", async () => {
    stubSessionFetch(sessionOk, () => apiError(500, "INTERNAL_ERROR"), noContent);
    withStoredConversation();

    const user = userEvent.setup();

    await openHome();
    await user.click(screen.getByRole("button", { name: "Clear conversation" }));
    await user.click(screen.getByRole("button", { name: "Delete conversation" }));

    expect(await screen.findByText("We couldn't clear the conversation.")).toBeInTheDocument();
    expect(screen.getByText("Resposta")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { level: 2, name: "Head Coach" }),
    ).toBeInTheDocument();
  });

  it("is disabled while an answer is being generated", async () => {
    const base = stubSessionFetch(sessionOk);
    const stubbed = globalThis.fetch;

    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input).endsWith("/messages")
        ? Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode('event: delta\ndata: {"text":"Em curso"}\n\n'),
                  );
                },
              }),
              { status: 200 },
            ),
          )
        : stubbed(input, init),
    );
    withStoredConversation();

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Oi{Enter}");
    await screen.findByText("Em curso");

    expect(screen.getByRole("button", { name: "Clear conversation" })).toBeDisabled();
    expect(base).not.toHaveBeenCalledWith(expect.stringMatching(/DELETE/));
  });
});
