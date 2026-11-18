import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_KEY } from "../../lib/access-token";
import {
  EXPERTS_FIXTURE,
  HOME_HEADING,
  jsonResponse,
  renderApp,
  SESSION_USER,
  stubSessionFetch,
  withExpertsCatalog,
} from "../../test/render-app";

const originalFetch = globalThis.fetch;
const TOKEN = "header.payload.signature";

const sessionOk = () => jsonResponse(200, { user: SESSION_USER });

function sseResponse(...events: Array<[string, unknown]>): Response {
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

const answer = (...texts: string[]) =>
  sseResponse(...texts.map((text): [string, unknown] => ["delta", { text }]), ["done", {}]);

function apiError(status: number, code: string): Response {
  return jsonResponse(status, { error: { code, message: "Server message.", details: [] } });
}

/** The calls to the messages endpoint: `[expertId, body]`. */
function messageCalls(fetchMock: ReturnType<typeof stubSessionFetch>) {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/messages"))
    .map(([url, init]) => ({
      expertId: /\/experts\/([^/]+)\/messages$/.exec(String(url))?.[1],
      body: JSON.parse(String(init?.body)) as { content: string },
      signal: init?.signal,
    }));
}

/**
 * An answer that sends `text` and then stays open, like a real connection: aborting the request
 * ends the body with an `AbortError`, as `fetch` does.
 */
function openAnswer(text: string, signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`event: delta
data: ${JSON.stringify({ text })}

`),
      );
      signal?.addEventListener("abort", () =>
        controller.error(new DOMException("Aborted", "AbortError")),
      );
    },
  });

  return new Response(body, { status: 200 });
}

/** Session and catalog as usual; the messages endpoint answers with `openAnswer(text)`. */
function stubOpenAnswer(text: string) {
  const fetchMock = stubSessionFetch(sessionOk);
  const base = globalThis.fetch;
  const send = vi.fn<typeof fetch>((input, init) =>
    String(input).includes("/messages")
      ? Promise.resolve(openAnswer(text, init?.signal))
      : base(input, init),
  );

  vi.stubGlobal("fetch", send);

  return { fetchMock, send };
}

async function openHome() {
  const result = renderApp("/app");

  await screen.findByRole("heading", { level: 1, name: HOME_HEADING });
  await screen.findByRole("combobox", { name: "Expert" });
  // The stored conversation loads first: the field is ready once it arrived.
  await waitFor(() => expect(textbox()).toBeEnabled());

  return result;
}

const textbox = () => screen.getByRole("textbox", { name: /^Message for the/ });

beforeEach(() => {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, TOKEN);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

describe("the home chat: layout and catalog", () => {
  it("shows the header, the empty state of the head coach and the bar with dropdown, field and Send", async () => {
    stubSessionFetch(sessionOk);
    await openHome();

    expect(screen.getByRole("img", { name: "Rondo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Head Coach" })).toBeInTheDocument();
    expect(screen.getByText("A veteran coach who reads the game.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Expert" })).toHaveValue("head-coach");
    expect(textbox()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("log", { name: "Conversation" })).toBeEmptyDOMElement();
  });

  it("lists every expert with name and role in the dropdown", async () => {
    stubSessionFetch(sessionOk);
    await openHome();

    const options = within(screen.getByRole("combobox", { name: "Expert" })).getAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual(
      EXPERTS_FIXTURE.map((expert) => `${expert.name} - ${expert.role}`),
    );
  });

  it("shows a loading status while the catalog loads", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = stubSessionFetch(sessionOk);

    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input).endsWith("/experts")
        ? new Promise<Response>((resolve) => (release = resolve))
        : withExpertsCatalog(fetchMock)(input, init),
    );
    renderApp("/app");

    expect(await screen.findByText("Loading the experts…")).toBeInTheDocument();

    release(jsonResponse(200, { experts: EXPERTS_FIXTURE }));

    expect(await screen.findByRole("combobox", { name: "Expert" })).toBeInTheDocument();
  });

  it("shows an error with Try again when the catalog fails, and recovers", async () => {
    const fetchMock = stubSessionFetch(sessionOk);
    let attempts = 0;

    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/experts")) {
        attempts += 1;

        return Promise.resolve(
          attempts === 1
            ? apiError(500, "INTERNAL_ERROR")
            : jsonResponse(200, { experts: EXPERTS_FIXTURE }),
        );
      }

      return fetchMock(input, init);
    });

    const user = userEvent.setup();

    renderApp("/app");

    expect(await screen.findByText("We couldn't load the experts.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("combobox", { name: "Expert" })).toBeInTheDocument();
  });
});

describe("the home chat: experts and notice", () => {
  it("switches the panel and the notice with the dropdown, by keyboard", async () => {
    stubSessionFetch(sessionOk);

    const user = userEvent.setup();

    await openHome();

    const notice = "Informational support only. It does not replace a licensed professional.";

    expect(screen.queryByText(notice)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Expert" }), "sports-lawyer");

    expect(screen.getByRole("heading", { level: 2, name: "Sports Lawyer" })).toBeInTheDocument();
    expect(screen.getByText(notice)).toBeInTheDocument();
    expect(textbox()).toHaveAccessibleDescription(notice);

    await user.selectOptions(screen.getByRole("combobox", { name: "Expert" }), "head-coach");

    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });
});

describe("the home chat: sending", () => {
  it("sends a suggestion as it is written and streams the answer into one bubble", async () => {
    const fetchMock = stubSessionFetch(sessionOk, () =>
      answer("Vamos ", "treinar ", "bola parada."),
    );
    const user = userEvent.setup();

    await openHome();
    await user.click(screen.getByRole("button", { name: "Qual escalação você sugere?" }));

    const log = screen.getByRole("log", { name: "Conversation" });

    expect(await within(log).findByText("Vamos treinar bola parada.")).toBeInTheDocument();
    expect(within(log).getByText("Qual escalação você sugere?")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Head Coach" })).not.toBeInTheDocument();
    expect(messageCalls(fetchMock)).toEqual([
      expect.objectContaining({
        expertId: "head-coach",
        body: { content: "Qual escalação você sugere?" },
      }),
    ]);
    await waitFor(() => expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "false"));
  });

  it("sends the typed text with Enter, clears the field and keeps a line break with Shift+Enter", async () => {
    const fetchMock = stubSessionFetch(sessionOk, () => answer("Ok."));
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "linha um{Shift>}{Enter}{/Shift}linha dois");

    expect(textbox()).toHaveValue("linha um\nlinha dois");

    await user.keyboard("{Enter}");

    await screen.findByText("Ok.");
    expect(textbox()).toHaveValue("");
    expect(messageCalls(fetchMock)[0]?.body.content).toBe("linha um\nlinha dois");
  });

  it("sends only the new text: the history lives on the server (R4)", async () => {
    const fetchMock = stubSessionFetch(
      sessionOk,
      () => answer("Primeira."),
      () => answer("Segunda."),
    );
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "P1{Enter}");
    await screen.findByText("Primeira.");
    await user.type(textbox(), "P2{Enter}");
    await screen.findByText("Segunda.");

    expect(messageCalls(fetchMock).map((call) => call.body)).toEqual([
      { content: "P1" },
      { content: "P2" },
    ]);
  });

  it("does not send an empty or too long message", async () => {
    const fetchMock = stubSessionFetch(sessionOk);
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "   {Enter}");

    expect(messageCalls(fetchMock)).toHaveLength(0);

    await user.click(textbox());
    await user.paste("x".repeat(4001));

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText("Messages can have at most 4,000 characters.")).toBeInTheDocument();
    expect(messageCalls(fetchMock)).toHaveLength(0);
  });

  it("shows the indicator until the first token and blocks a second send", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = stubSessionFetch(
      sessionOk,
      () => new Promise<Response>((resolve) => (release = resolve)) as never,
    );
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Oi{Enter}");

    expect(await screen.findByText("The expert is answering…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    await user.type(textbox(), "outra{Enter}");

    expect(messageCalls(fetchMock)).toHaveLength(1);

    release(answer("Pronto."));

    expect(await screen.findByText("Pronto.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});

describe("the home chat: failures, stop and retry", () => {
  it("shows the error with Try again and asks the same question again without duplicating it", async () => {
    const fetchMock = stubSessionFetch(
      sessionOk,
      () => apiError(500, "INTERNAL_ERROR"),
      () => answer("Agora foi."),
    );
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Pergunta{Enter}");

    expect(await screen.findByText("The expert couldn't answer.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Agora foi.")).toBeInTheDocument();
    expect(screen.getAllByText("Pergunta")).toHaveLength(1);
    expect(screen.queryByText("The expert couldn't answer.")).not.toBeInTheDocument();
    expect(messageCalls(fetchMock).map((call) => call.body)).toEqual([
      { content: "Pergunta" },
      { content: "Pergunta" },
    ]);
  });

  it("explains 503 EXPERT_UNAVAILABLE", async () => {
    stubSessionFetch(sessionOk, () => apiError(503, "EXPERT_UNAVAILABLE"));

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Oi{Enter}");

    expect(await screen.findByText("The experts are unavailable right now.")).toBeInTheDocument();
  });

  it("explains 429", async () => {
    stubSessionFetch(sessionOk, () => apiError(429, "RATE_LIMITED"));

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Oi{Enter}");

    expect(await screen.findByText(/You're sending messages too fast/)).toBeInTheDocument();
  });

  it("keeps the text that arrived and marks the answer incomplete when the stream is cut", async () => {
    stubSessionFetch(sessionOk, () => sseResponse(["delta", { text: "Metade" }]));

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Oi{Enter}");

    expect(await screen.findByText("Metade")).toBeInTheDocument();
    expect(await screen.findByText("Incomplete answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("treats an error event of the stream as a failure of the answer", async () => {
    stubSessionFetch(sessionOk, () =>
      sseResponse(["error", { code: "EXPERT_ANSWER_FAILED", message: "Failed." }]),
    );

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Oi{Enter}");

    expect(await screen.findByText("The expert couldn't answer.")).toBeInTheDocument();
  });

  it("aborts the call on Stop and leaves the partial answer marked incomplete", async () => {
    const { send } = stubOpenAnswer("Em curso");
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Oi{Enter}");
    await screen.findByText("Em curso");
    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(await screen.findByText("Incomplete answer")).toBeInTheDocument();
    expect(screen.getByText("Em curso")).toBeInTheDocument();
    expect(
      send.mock.calls.find(([url]) => String(url).includes("/messages"))?.[1]?.signal?.aborted,
    ).toBe(true);
    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("explains 409 CONVERSATION_BUSY and lets the person try again", async () => {
    stubSessionFetch(sessionOk, () => apiError(409, "CONVERSATION_BUSY"));

    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Oi{Enter}");

    expect(await screen.findByText("This expert is still answering.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("aborts the answer and shows the conversation of the new expert when another expert is chosen", async () => {
    const { send } = stubOpenAnswer("Falando");
    const user = userEvent.setup();

    await openHome();
    await user.type(textbox(), "Oi{Enter}");
    await screen.findByText("Falando");
    await user.selectOptions(screen.getByRole("combobox", { name: "Expert" }), "physiologist");

    expect(screen.getByRole("heading", { level: 2, name: "Physiologist" })).toBeInTheDocument();
    expect(screen.queryByText("Falando")).not.toBeInTheDocument();
    expect(
      send.mock.calls.find(([url]) => String(url).includes("/messages"))?.[1]?.signal?.aborted,
    ).toBe(true);
  });

  it("sends to the route of the selected expert", async () => {
    const fetchMock = stubSessionFetch(sessionOk, () => answer("Ok."));
    const user = userEvent.setup();

    await openHome();
    await user.selectOptions(screen.getByRole("combobox", { name: "Expert" }), "physiologist");
    await user.click(screen.getByRole("button", { name: "Como controlar a carga de treino?" }));
    await screen.findByText("Ok.");

    expect(messageCalls(fetchMock)[0]?.expertId).toBe("physiologist");
  });
});
