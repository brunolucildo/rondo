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
import { checkLinkBeforeSend, type ConnectionDto, linkLabel } from "./connection-messages";

const originalFetch = globalThis.fetch;
const TOKEN = "header.payload.signature";
const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const CONNECTION_ID = "7e3f4d2b-0c8f-4e69-9b42-3d5f6a7b8c9d";
const SECRET = "SEGREDO-NA-URL";

const connection = (overrides: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: CONNECTION_ID,
  name: "exemplo.com/regulamento",
  kind: "url",
  sizeBytes: 4321,
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

const isLinkPost = (call: Call) => call.method === "POST" && call.url.endsWith("/connections/url");

async function openHome() {
  renderApp("/app");

  await screen.findByRole("heading", { level: 1, name: HOME_HEADING });
  await screen.findByRole("combobox", { name: "Expert" });
  // The composer stays disabled (and is rebuilt) until the stored conversation has loaded.
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: /^Message for the/ })).toBeEnabled(),
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add link" }));

  return screen.findByRole("dialog", { name: "Add a link" });
}

const linkField = () => screen.getByRole("textbox", { name: "Link" });
const findChip = async () =>
  within(await screen.findByRole("list", { name: "Attachments" })).getByRole("listitem");

beforeEach(() => {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, TOKEN);
  window.localStorage.setItem(PRIVACY_KEY, "true");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("link helpers", () => {
  it("checks a link before sending", () => {
    expect(checkLinkBeforeSend("https://exemplo.com/a")).toBeNull();
    expect(checkLinkBeforeSend("  http://exemplo.com  ")).toBeNull();
    expect(checkLinkBeforeSend("")).toBe("Enter a link.");
    expect(checkLinkBeforeSend("exemplo.com")).toMatch(/valid link/);
    expect(checkLinkBeforeSend("ftp://exemplo.com")).toMatch(/http:\/\//);
    expect(checkLinkBeforeSend("http://user:pw@exemplo.com")).toMatch(/user name/);
    expect(checkLinkBeforeSend("http://exemplo.com:5432")).toMatch(/ports/);
    expect(checkLinkBeforeSend(`https://exemplo.com/${"a".repeat(2050)}`)).toMatch(/2,048/);
  });

  it("labels a link by host and path only", () => {
    expect(linkLabel(`https://exemplo.com/regulamento/?token=${SECRET}#a`)).toBe(
      "exemplo.com/regulamento",
    );
    expect(linkLabel("https://exemplo.com/")).toBe("exemplo.com");
    expect(linkLabel("not a link")).toBe("Link");
  });
});

describe("the field Link (R9)", () => {
  it("opens a labelled dialog with the field focused and the button disabled while it is empty", async () => {
    stubApi(() => jsonResponse(500, {}));

    const user = userEvent.setup();

    await openHome();

    const dialog = await openDialog(user);

    await waitFor(() => expect(linkField()).toHaveFocus());
    expect(within(dialog).getByRole("button", { name: "Connect link" })).toBeDisabled();

    await user.type(linkField(), "https://exemplo.com/regulamento");

    expect(within(dialog).getByRole("button", { name: "Connect link" })).toBeEnabled();
  });

  it("closes with Escape and Cancel, sending nothing", async () => {
    const calls = stubApi(() => jsonResponse(500, {}));
    const user = userEvent.setup();

    await openHome();
    await openDialog(user);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("explains an invalid link next to the field, keeps the text and sends nothing", async () => {
    const calls = stubApi(() => jsonResponse(500, {}));
    const user = userEvent.setup();

    await openHome();
    await openDialog(user);
    await user.type(linkField(), "ftp://exemplo.com/arquivo");
    await user.click(screen.getByRole("button", { name: "Connect link" }));

    expect(linkField()).toHaveAttribute("aria-invalid", "true");
    expect(linkField()).toHaveAccessibleDescription("Links must start with http:// or https://.");
    expect(linkField()).toHaveValue("ftp://exemplo.com/arquivo");
    expect(screen.getByRole("dialog", { name: "Add a link" })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("turns a valid link into a chip named by host and path, never by the query", async () => {
    const calls = stubApi((call) =>
      isLinkPost(call)
        ? jsonResponse(202, { ...connection(), deduplicated: false })
        : jsonResponse(200, connection()),
    );
    const user = userEvent.setup();

    await openHome();
    await openDialog(user);
    await user.type(linkField(), `https://exemplo.com/regulamento?token=${SECRET}#secao`);
    await user.click(screen.getByRole("button", { name: "Connect link" }));

    const chip = await findChip();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(chip).getByText("exemplo.com/regulamento")).toBeInTheDocument();
    expect(within(chip).getByRole("status")).toHaveTextContent("Processing…");
    expect(chip.textContent).not.toContain(SECRET);

    const post = calls.find(isLinkPost);

    expect(JSON.parse(String(post?.body))).toEqual({
      url: `https://exemplo.com/regulamento?token=${SECRET}#secao`,
    });
  });

  it("holds Send back until the link is ready, then enables it", async () => {
    stubApi((call) =>
      isLinkPost(call)
        ? jsonResponse(202, { ...connection(), deduplicated: false })
        : jsonResponse(200, connection({ status: "ready", chunkCount: 3 })),
    );

    const user = userEvent.setup();

    await openHome();
    await user.type(screen.getByRole("textbox", { name: /^Message for the/ }), "What is the rule?");
    await openDialog(user);
    await user.type(linkField(), "https://exemplo.com/regulamento");
    await user.click(screen.getByRole("button", { name: "Connect link" }));

    expect(await screen.findByText("Processing…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(await screen.findByText("Ready", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

describe("a link the server refuses", () => {
  const refuse = (status: number, code: string) =>
    jsonResponse(status, { error: { code, message: "Server text.", details: [] } });

  it("shows only that a blocked link can't be used, with no technical reason and no retry", async () => {
    stubApi(() => refuse(400, "URL_NOT_ALLOWED"));

    const user = userEvent.setup();

    await openHome();
    await openDialog(user);
    await user.type(linkField(), "http://169.254.169.254/latest");
    await user.click(screen.getByRole("button", { name: "Connect link" }));

    const chip = await findChip();

    expect(await within(chip).findByText("This link can't be used.")).toBeInTheDocument();
    expect(chip.textContent).not.toMatch(/internal|private|address|SSRF/i);
    expect(within(chip).queryByRole("button", { name: /^Try again/ })).not.toBeInTheDocument();
    expect(within(chip).getByRole("button", { name: /^Remove/ })).toBeInTheDocument();
  });

  it.each([
    [422, "FETCH_TIMEOUT", "The page took too long to answer. Try again in a moment.", true],
    [422, "RESPONSE_TOO_LARGE", "This page is too large. Links can have at most 5 MB.", false],
    [
      422,
      "UNSUPPORTED_CONTENT_TYPE",
      "This link must lead to a web page, a text file, Markdown or a PDF.",
      false,
    ],
    [
      422,
      "NO_EXTRACTABLE_TEXT",
      "We couldn't find any text on this page. Pages that need a login or JavaScript are not supported.",
      false,
    ],
    [409, "CONNECTION_LIMIT_REACHED", "You reached the limit of 50 connections.", false],
    [429, "RATE_LIMITED", "Too many links. Try again in a few minutes.", true],
  ])(
    "says what %i %s means and whether trying again can help",
    async (status, code, text, retry) => {
      stubApi(() => refuse(status, code));

      const user = userEvent.setup();

      await openHome();
      await openDialog(user);
      await user.type(linkField(), "https://exemplo.com/regulamento");
      await user.click(screen.getByRole("button", { name: "Connect link" }));

      const chip = await findChip();

      expect(await within(chip).findByText(text)).toBeInTheDocument();
      expect(within(chip).queryByRole("button", { name: /^Try again/ }) !== null).toBe(retry);
    },
  );

  it("sends the same link again on Try again", async () => {
    let posts = 0;
    const calls = stubApi((call) => {
      if (isLinkPost(call)) {
        posts += 1;

        return posts === 1
          ? refuse(422, "FETCH_TIMEOUT")
          : jsonResponse(200, {
              ...connection({ status: "ready", chunkCount: 2 }),
              deduplicated: false,
            });
      }

      return jsonResponse(200, connection({ status: "ready", chunkCount: 2 }));
    });
    const user = userEvent.setup();

    await openHome();
    await openDialog(user);
    await user.type(linkField(), `https://exemplo.com/regulamento?token=${SECRET}`);
    await user.click(screen.getByRole("button", { name: "Connect link" }));
    await user.click(
      await screen.findByRole("button", { name: "Try again with exemplo.com/regulamento" }),
    );

    expect(await screen.findByText("Ready")).toBeInTheDocument();

    const bodies = calls.filter(isLinkPost).map((call) => JSON.parse(String(call.body)));

    expect(bodies).toEqual([
      { url: `https://exemplo.com/regulamento?token=${SECRET}` },
      { url: `https://exemplo.com/regulamento?token=${SECRET}` },
    ]);
  });
});

describe("the privacy notice covers links", () => {
  it("asks before the first link, mentions pages and sends nothing on Cancel", async () => {
    window.localStorage.removeItem(PRIVACY_KEY);

    const calls = stubApi(() => jsonResponse(202, { ...connection(), deduplicated: false }));
    const user = userEvent.setup();

    await openHome();
    await openDialog(user);
    await user.type(linkField(), "https://exemplo.com/regulamento");
    await user.click(screen.getByRole("button", { name: "Connect link" }));

    const notice = await screen.findByRole("dialog", { name: "Before you connect a file" });

    expect(notice).toHaveAccessibleDescription(/page behind a link/);
    expect(calls).toEqual([]);

    await user.click(within(notice).getByRole("button", { name: "Cancel" }));

    expect(calls).toEqual([]);
    expect(screen.queryByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
  });
});

describe("a link in the list of connections", () => {
  it("is listed with the kind Link", async () => {
    stubApi((call) =>
      call.url.endsWith("/connections") && call.method === "GET"
        ? jsonResponse(200, {
            connections: [connection({ status: "ready", chunkCount: 3 })],
          })
        : jsonResponse(500, {}),
    );

    const user = userEvent.setup();

    await openHome();
    await user.click(screen.getByRole("button", { name: /Your connections/ }));

    const row = await screen.findByText("exemplo.com/regulamento");

    expect(row.closest("li")).toHaveTextContent("Link ·");
  });
});
