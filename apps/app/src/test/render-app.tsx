import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { type Mock, vi } from "vitest";
import { App } from "../App";
import { createQueryClient } from "../lib/query-client";
import { createAppRouter, redirectToSignIn, type RouteFactory } from "../router";

export interface RenderAppOptions {
  extraRoutes?: { auth?: RouteFactory[]; app?: RouteFactory[] };
}

/** Renders the whole app (router and query client, wired like `main.tsx`) at a path. */
export function renderApp(path: string, { extraRoutes }: RenderAppOptions = {}) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    extraRoutes,
  });
  const queryClient = createQueryClient(() => redirectToSignIn(router));

  render(
    <QueryClientProvider client={queryClient}>
      <App router={router} />
    </QueryClientProvider>,
  );

  return { router, queryClient };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const SESSION_USER = {
  id: "5f1b6c1e-2d3a-4e5f-8a9b-0c1d2e3f4a5b",
  firstName: "Ana",
  lastName: "Silva",
  email: "ana@example.test",
};

export function unauthenticatedResponse(): Response {
  return jsonResponse(401, {
    error: { code: "UNAUTHENTICATED", message: "Authentication required.", details: [] },
  });
}

/** The catalog the home loads (`GET /experts`); a short version of the real seven. */
export const EXPERTS_FIXTURE = [
  {
    id: "head-coach",
    name: "Head Coach",
    role: "Training, lineup and strategy decisions",
    characterName: "Arnaldo Pinheiro Lessa",
    description: "A veteran coach who reads the game.",
    suggestedQuestions: ["Qual escalação você sugere?", "Como montar a semana de treinos?"],
    notice: null,
  },
  {
    id: "physiologist",
    name: "Physiologist",
    role: "Training load, recovery and prevention",
    characterName: "Marta Quintela Ribas",
    description: "Helps manage training load.",
    suggestedQuestions: ["Como controlar a carga de treino?", "Como organizar a recuperação?"],
    notice: "Informational support only. It does not replace a licensed professional.",
  },
  {
    id: "sports-lawyer",
    name: "Sports Lawyer",
    role: "Contracts, regulations and transfers",
    characterName: "Heitor Camargo Valente",
    description: "Points out contract risks.",
    suggestedQuestions: ["Quais cláusulas merecem atenção?", "Monte um checklist de registro."],
    notice: "Informational support only. It does not replace a licensed professional.",
  },
];

export const isExpertsRequest = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  String(input).endsWith("/experts") && (init?.method ?? "GET") === "GET";

const CONVERSATION_PATH = /\/experts\/([^/]+)\/conversation$/;

export const isConversationRead = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  CONVERSATION_PATH.test(String(input)) && (init?.method ?? "GET") === "GET";

/** A stored message as `GET /experts/:expertId/conversation` returns it. */
export function storedMessage(
  index: number,
  role: "user" | "assistant",
  content: string,
  status: "complete" | "incomplete" = "complete",
) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    role,
    content,
    status,
    createdAt: new Date(Date.UTC(2026, 10, 17, 12, 0, index)).toISOString(),
  };
}

/**
 * What `GET /experts/:expertId/conversation` answers, by expert id; an expert that is not here has
 * no conversation (an empty list). `stubSessionFetch` empties it, so a test sets its own after.
 */
export const storedConversations = new Map<string, () => Response | Promise<Response>>();

/**
 * Replaces `fetch` with a mock that answers the given responses in order, for every call except
 * `GET /experts`: the home asks for the catalog and gets `EXPERTS_FIXTURE` without using up one of
 * the responses (nor showing in the returned mock's calls).
 */
export function stubSessionFetch(
  ...responses: Array<() => Response | Promise<Response>>
): Mock<typeof fetch> {
  const fetchMock: Mock<typeof fetch> = vi.fn();

  storedConversations.clear();

  for (const response of responses) {
    fetchMock.mockImplementationOnce(() => Promise.resolve(response()));
  }

  vi.stubGlobal("fetch", withExpertsCatalog(fetchMock));

  return fetchMock;
}

/**
 * Wraps a fetch mock so that `GET /experts` is answered with `EXPERTS_FIXTURE` and the read of a
 * conversation with `storedConversations` (empty by default); neither reaches the mock.
 */
export function withExpertsCatalog(fetchMock: typeof fetch): typeof fetch {
  return (input, init) => {
    if (isExpertsRequest(input, init)) {
      return Promise.resolve(jsonResponse(200, { experts: EXPERTS_FIXTURE }));
    }

    if (isConversationRead(input, init)) {
      const expertId = CONVERSATION_PATH.exec(String(input))?.[1] ?? "";
      const stored = storedConversations.get(expertId);

      return Promise.resolve(
        stored === undefined ? jsonResponse(200, { messages: [], nextCursor: null }) : stored(),
      );
    }

    return fetchMock(input, init);
  };
}

/** What the page shows once the signed-in area is ready (a heading for assistive technology). */
export const HOME_HEADING = "Chat with the experts";
