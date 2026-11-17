import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/bootstrap";
import { SessionService } from "../src/modules/auth/application/services/session.service";
import { EXPERT_ORCHESTRATOR } from "../src/modules/experts";
import { buildSystemPrompt } from "../src/modules/experts/domain/expert-conversation";
import { EXPERTS } from "../src/modules/experts/domain/expert-catalog";
import {
  type OrchestratorScript,
  FakeExpertOrchestrator,
  speaks,
  waitsForAbort,
} from "./support/fake-expert-orchestrator";
import { assertMigrationsApplied, deleteUsersByEmail, query, rows } from "./support/database";
import { resetRateLimitStore } from "./support/rate-limit";
import { seedConfirmedUser } from "./support/sessions";
import { answerText, parseSse, readText } from "./support/sse";

const EXPERTS_PATH = "/api/v1/experts";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "incomplete";
  createdAt: string;
}

interface Page {
  messages: Message[];
  nextCursor: string | null;
}

/** Streams one piece and then stays open until the client leaves, like a model call that is stopped. */
const speaksThenWaits =
  (piece: string): OrchestratorScript =>
  ({ signal }) =>
    (async function* () {
      yield { type: "text", text: piece } as const;
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    })();

describe("the conversation of the experts in the database (R1, R8)", () => {
  const createdEmails: string[] = [];
  let userId: string;

  beforeAll(async () => {
    await assertMigrationsApplied();

    const user = await seedConfirmedUser("conversation-db");

    createdEmails.push(user.email);
    userId = user.id;
  });

  afterAll(async () => {
    await deleteUsersByEmail(createdEmails);
  });

  const append = (role: string, content: string, expertId = "head-coach", max = 200) =>
    rows<{ message_id: string }>(
      "select message_id from public.expert_append_message($1, $2, $3, $4, 'complete', $5)",
      [userId, expertId, role, content, max],
    );
  const count = async (expertId = "head-coach") =>
    Number(
      (
        await rows<{ total: string }>(
          `select count(*) as total from public.expert_messages m
             join public.expert_conversations c on c.id = m.conversation_id
            where c.user_id = $1 and c.expert_id = $2`,
          [userId, expertId],
        )
      )[0]?.total,
    );

  beforeEach(async () => {
    await query("delete from public.expert_conversations where user_id = $1", [userId]);
  });

  it("lets rondo_app do DML on both tables and refuses DDL with 42501", async () => {
    for (const table of ["expert_conversations", "expert_messages"]) {
      const privileges = await rows<{ privilege: string; allowed: boolean }>(
        `select p as privilege, has_table_privilege('rondo_app', $1, p) as allowed
           from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as p`,
        [`public.${table}`],
      );
      const allowed = privileges.filter((row) => row.allowed).map((row) => row.privilege);

      expect(allowed).toEqual(expect.arrayContaining(["select", "insert", "delete"]));
      expect(allowed).not.toContain("truncate");
    }

    await expect(query("create table public.expert_extra (id int)")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      query("alter table public.expert_messages add column extra int"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(query("drop table public.expert_messages")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(query("drop table public.expert_conversations")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("has the index by (conversation_id, created_at) and one conversation per (user, expert)", async () => {
    const indexes = await rows<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'expert_messages'",
    );

    expect(
      indexes.some((index) => /\(conversation_id, created_at, id\)/.test(index.indexdef)),
    ).toBe(true);

    await append("user", "primeira");
    await expect(
      query(
        "insert into public.expert_conversations (user_id, expert_id) values ($1, 'head-coach')",
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses an invalid role, status, empty content and an unknown user", async () => {
    await expect(append("system", "x")).rejects.toMatchObject({ code: "23514" });
    await expect(append("user", "")).rejects.toMatchObject({ code: "23514" });
    await expect(
      query(
        "select * from public.expert_append_message($1, 'head-coach', 'user', 'x', 'weird', 200)",
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      query(
        "select * from public.expert_append_message($1, 'head-coach', 'user', 'x', 'complete', 200)",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      query(
        "select * from public.expert_append_message($1, 'Bad Id', 'user', 'x', 'complete', 200)",
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      query(
        "select * from public.expert_append_message($1, 'head-coach', 'user', 'x', 'complete', 0)",
        [userId],
      ),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("keeps 200 messages: writing the 201st removes the oldest in the same call (R8)", async () => {
    for (let index = 1; index <= 201; index += 1) {
      await append(index % 2 === 1 ? "user" : "assistant", `message ${index}`);
    }

    const stored = await rows<{ content: string }>(
      `select m.content from public.expert_messages m
         join public.expert_conversations c on c.id = m.conversation_id
        where c.user_id = $1 and c.expert_id = 'head-coach'
        order by m.created_at, m.id`,
      [userId],
    );

    expect(stored).toHaveLength(200);
    expect(stored[0]?.content).toBe("message 2");
    expect(stored.at(-1)?.content).toBe("message 201");
  });

  it("keeps the limit under simultaneous writes and never loses the newest message", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        append("user", `parallel ${index}`, "head-coach", 5),
      ),
    );

    expect(await count()).toBe(5);
  });

  it("trims each conversation on its own", async () => {
    for (let index = 1; index <= 4; index += 1) {
      await append("user", `a${index}`, "head-coach", 3);
      await append("user", `b${index}`, "physiologist", 3);
    }

    expect(await count("head-coach")).toBe(3);
    expect(await count("physiologist")).toBe(3);
  });

  it("deletes the messages with the conversation, and the conversations with the user", async () => {
    await append("user", "oi");
    await query("delete from public.expert_conversations where user_id = $1", [userId]);

    expect(await count()).toBe(0);

    const other = await seedConfirmedUser("conversation-cascade");

    createdEmails.push(other.email);
    await query(
      "select * from public.expert_append_message($1, 'head-coach', 'user', 'oi', 'complete', 200)",
      [other.id],
    );
    await deleteUsersByEmail([other.email]);

    expect(
      await rows("select 1 from public.expert_conversations where user_id = $1", [other.id]),
    ).toEqual([]);
  });
});

describe("conversation API with a fake model (R2 to R10)", () => {
  const createdEmails: string[] = [];
  const model = new FakeExpertOrchestrator();
  let app: INestApplication;
  let sessions: SessionService;
  let a: { id: string; token: string };
  let b: { id: string; token: string };

  const send = (auth: { token: string }, expertId: string, body: unknown = { content: "oi" }) =>
    request(app.getHttpServer())
      .post(`${EXPERTS_PATH}/${expertId}/messages`)
      .set(bearer(auth.token))
      .buffer(true)
      .parse(readText)
      .send(body as object);
  const get = (auth: { token: string } | null, expertId: string, queryString = "") => {
    const call = request(app.getHttpServer()).get(
      `${EXPERTS_PATH}/${expertId}/conversation${queryString}`,
    );

    return auth === null ? call : call.set(bearer(auth.token));
  };
  const clear = (auth: { token: string } | null, expertId: string) => {
    const call = request(app.getHttpServer()).delete(`${EXPERTS_PATH}/${expertId}/conversation`);

    return auth === null ? call : call.set(bearer(auth.token));
  };
  const page = async (auth: { token: string }, expertId: string, queryString = "") =>
    (await get(auth, expertId, queryString)).body as Page;
  const newUser = async (label: string) => {
    const user = await seedConfirmedUser(label);

    createdEmails.push(user.email);

    return { id: user.id, token: (await sessions.issue(user.id)).accessToken };
  };
  /** Puts `total` messages in a conversation, one second apart, as if they were exchanged earlier. */
  const seed = (userId: string, expertId: string, total: number) =>
    query(
      `with conversation as (
         insert into public.expert_conversations (user_id, expert_id) values ($1, $2)
         on conflict on constraint expert_conversations_user_expert_key
           do update set expert_id = excluded.expert_id
         returning id)
       insert into public.expert_messages (conversation_id, role, content, created_at)
       select conversation.id,
              case when n % 2 = 1 then 'user' else 'assistant' end,
              'message ' || n,
              now() - make_interval(secs => ($3 - n))
         from conversation, generate_series(1, $3::int) as n`,
      [userId, expertId, total],
    );
  const storedCount = async (userId: string) =>
    Number(
      (
        await rows<{ total: string }>(
          `select count(*) as total from public.expert_messages m
             join public.expert_conversations c on c.id = m.conversation_id where c.user_id = $1`,
          [userId],
        )
      )[0]?.total,
    );

  beforeAll(async () => {
    await assertMigrationsApplied();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EXPERT_ORCHESTRATOR)
      .useValue(model)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    // Really listening: the Stop tests need a socket the client can close.
    await app.listen(0);
    sessions = app.get(SessionService);
    a = await newUser("conversation-a");
    b = await newUser("conversation-b");
  });

  afterAll(async () => {
    await app.close();
    await deleteUsersByEmail(createdEmails);
  });

  beforeEach(async () => {
    await query("delete from public.expert_conversations where user_id = any($1::uuid[])", [
      [a.id, b.id],
    ]);
    resetRateLimitStore(app);
    model.available = true;
    model.calls.length = 0;
    model.use(speaks(["Fake ", "answer."]));
  });

  describe("GET /experts/:expertId/conversation (R2)", () => {
    it("answers 401 without a session", async () => {
      const response = await get(null, "head-coach");

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("answers 200 with an empty list when there is no conversation", async () => {
      const response = await get(a, "head-coach");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ messages: [], nextCursor: null });
    });

    it("answers 404 EXPERT_NOT_FOUND for an unknown expert", async () => {
      const response = await get(a, "goalkeeper");

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("EXPERT_NOT_FOUND");
    });

    it("returns the 50 newest of 120 messages in chronological order, then the 50 before them", async () => {
      await seed(a.id, "head-coach", 120);

      const first = await page(a, "head-coach");

      expect(first.messages).toHaveLength(50);
      expect(first.messages[0]?.content).toBe("message 71");
      expect(first.messages.at(-1)?.content).toBe("message 120");
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(Object.keys(first.messages[0] ?? {}).sort()).toEqual([
        "citations",
        "content",
        "createdAt",
        "id",
        "role",
        "status",
      ]);

      const second = await page(a, "head-coach", `?before=${first.nextCursor}`);

      expect(second.messages).toHaveLength(50);
      expect(second.messages[0]?.content).toBe("message 21");
      expect(second.messages.at(-1)?.content).toBe("message 70");

      const third = await page(a, "head-coach", `?limit=50&before=${second.nextCursor}`);

      expect(third.messages).toHaveLength(20);
      expect(third.nextCursor).toBeNull();
    });

    it("honours limit and refuses values outside 1 to 50 or not whole, and a forged cursor, with 400", async () => {
      await seed(a.id, "head-coach", 10);

      expect((await page(a, "head-coach", "?limit=3")).messages).toHaveLength(3);

      for (const queryString of [
        "?limit=0",
        "?limit=51",
        "?limit=-2",
        "?limit=1.5",
        "?limit=abc",
        "?before=not-a-cursor",
        "?before=%27%3B%20drop%20table%20users%3B--",
        "?unknown=1",
      ]) {
        const response = await get(a, "head-coach", queryString);

        expect(response.status, queryString).toBe(400);
        expect(response.body.error.code, queryString).toBe("VALIDATION_FAILED");
      }
    });

    it("does not follow a cursor into the conversation of another user", async () => {
      await seed(a.id, "head-coach", 60);
      await seed(b.id, "head-coach", 60);

      const cursorOfA = (await page(a, "head-coach")).nextCursor;
      const stolen = await get(b, "head-coach", `?before=${cursorOfA}`);

      expect(stolen.status).toBe(200);
      expect(stolen.body).toEqual({ messages: [], nextCursor: null });
    });
  });

  describe("isolation between users (R3)", () => {
    it("lets each user read, send and clear only their own messages", async () => {
      await send(a, "head-coach", { content: "pergunta da A" });
      await send(b, "head-coach", { content: "pergunta da B" });

      const ofA = await page(a, "head-coach");
      const ofB = await page(b, "head-coach");

      expect(ofA.messages.map((message) => message.content)).toEqual([
        "pergunta da A",
        "Fake answer.",
      ]);
      expect(ofB.messages.map((message) => message.content)).toEqual([
        "pergunta da B",
        "Fake answer.",
      ]);

      // The model of B never saw the question of A.
      expect(JSON.stringify(model.calls[1]?.messages)).not.toContain("pergunta da A");

      expect((await clear(b, "head-coach")).status).toBe(204);
      expect((await page(b, "head-coach")).messages).toEqual([]);
      expect((await page(a, "head-coach")).messages).toHaveLength(2);
    });

    it("takes the user only from the session: a userId in the URL or body is refused", async () => {
      const injected = await request(app.getHttpServer())
        .post(`${EXPERTS_PATH}/head-coach/messages`)
        .set(bearer(a.token))
        .send({ content: "oi", userId: b.id });

      expect(injected.status).toBe(400);
      expect(await storedCount(b.id)).toBe(0);
    });
  });

  describe("POST /experts/:expertId/messages (R4, R5)", () => {
    it("stores the question and the answer, and the conversation comes back on the next read", async () => {
      const response = await send(a, "head-coach", { content: "Qual escalação?" });

      expect(answerText(parseSse(response.body as string))).toBe("Fake answer.");

      const stored = await page(a, "head-coach");

      expect(
        stored.messages.map(({ role, content, status }) => ({ role, content, status })),
      ).toEqual([
        { role: "user", content: "Qual escalação?", status: "complete" },
        { role: "assistant", content: "Fake answer.", status: "complete" },
      ]);
    });

    it("sends the persona, the last 20 stored messages and the new question to the model", async () => {
      await seed(a.id, "head-coach", 30);
      await send(a, "head-coach", { content: "Nova pergunta" });

      const [call] = model.calls;
      const head = EXPERTS.find((expert) => expert.id === "head-coach");

      expect(call?.messages).toHaveLength(22);
      expect(call?.messages[0]).toEqual({ role: "system", content: buildSystemPrompt(head!) });
      expect(call?.messages[1]?.content).toBe("message 11");
      expect(call?.messages[20]?.content).toBe("message 30");
      expect(call?.messages[21]).toEqual({ role: "user", content: "Nova pergunta" });
      expect(call?.messages.filter((message) => message.role === "system")).toHaveLength(1);
    });

    it("keeps the conversation of each expert apart", async () => {
      await send(a, "head-coach", { content: "para o técnico" });
      await send(a, "physiologist", { content: "para a fisiologia" });

      expect((await page(a, "head-coach")).messages[0]?.content).toBe("para o técnico");
      expect((await page(a, "physiologist")).messages[0]?.content).toBe("para a fisiologia");
      expect(JSON.stringify(model.calls[1]?.messages)).not.toContain("para o técnico");
    });

    it("keeps 200 messages when one more is written (R8)", async () => {
      await seed(a.id, "head-coach", 200);
      await send(a, "head-coach", { content: "a 201a e a 202a" });

      const stored = await rows<{ total: string }>(
        `select count(*) as total from public.expert_messages m
           join public.expert_conversations c on c.id = m.conversation_id
          where c.user_id = $1 and c.expert_id = 'head-coach'`,
        [a.id],
      );

      expect(Number(stored[0]?.total)).toBe(200);
      expect((await page(a, "head-coach")).messages.at(-2)?.content).toBe("a 201a e a 202a");
    });

    it("takes the question back when the model fails before any text, so Try again leaves no duplicate", async () => {
      model.use(() => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("down")) }),
      }));

      const failed = await send(a, "head-coach", { content: "vai falhar" });

      expect(parseSse(failed.body as string)[0]?.event).toBe("error");
      expect((await page(a, "head-coach")).messages).toEqual([]);

      model.use(speaks(["ok agora"]));
      await send(a, "head-coach", { content: "vai falhar" });

      expect((await page(a, "head-coach")).messages.map((message) => message.content)).toEqual([
        "vai falhar",
        "ok agora",
      ]);
    });

    it("rejects a body with history, without storing or calling the model (R5)", async () => {
      const response = await send(a, "head-coach", {
        content: "oi",
        history: [{ role: "user", content: "forjado" }],
      });

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body as string).error.code).toBe("VALIDATION_FAILED");
      expect(model.calls).toHaveLength(0);
      expect(await storedCount(a.id)).toBe(0);
    });

    it("does not store anything for an unknown expert, without a model, or without a session", async () => {
      expect((await send(a, "goalkeeper")).status).toBe(404);

      model.available = false;
      expect((await send(a, "head-coach")).status).toBe(503);
      model.available = true;

      const anonymous = await request(app.getHttpServer())
        .post(`${EXPERTS_PATH}/head-coach/messages`)
        .send({ content: "oi" });

      expect(anonymous.status).toBe(401);
      expect(await storedCount(a.id)).toBe(0);
    });
  });

  describe("Stop and the lock of one answer at a time (R4, R6)", () => {
    const open = async (auth: { token: string }, expertId: string, signal: AbortSignal) => {
      const { port } = app.getHttpServer().address() as { port: number };

      return fetch(`http://127.0.0.1:${port}${EXPERTS_PATH}/${expertId}/messages`, {
        method: "POST",
        headers: { ...bearer(auth.token), "content-type": "application/json" },
        body: JSON.stringify({ content: "pergunta longa" }),
        signal,
      });
    };

    it("stores the text received as incomplete when the client presses Stop", async () => {
      model.use(speaksThenWaits("resposta pela me"));

      const controller = new AbortController();
      const response = await open(a, "head-coach", controller.signal);
      const reader = response.body?.getReader();
      const first = await reader?.read();

      expect(new TextDecoder().decode(first?.value)).toContain("resposta pela me");
      controller.abort();
      await reader?.cancel().catch(() => undefined);

      await vi.waitFor(async () => {
        const stored = await page(a, "head-coach");

        expect(
          stored.messages.map(({ role, content, status }) => ({ role, content, status })),
        ).toEqual([
          { role: "user", content: "pergunta longa", status: "complete" },
          { role: "assistant", content: "resposta pela me", status: "incomplete" },
        ]);
      });

      // The incomplete answer goes to the model as it is, on the next question.
      await vi.waitFor(async () => {
        model.use(speaks(["ok"]));
        expect((await send(a, "head-coach", { content: "e agora?" })).status).toBe(200);
      });
      expect(model.calls.at(-1)?.messages.map((message) => message.content)).toContain(
        "resposta pela me",
      );
    });

    it("answers 409 CONVERSATION_BUSY to a second send of the same user and expert, and not to another expert", async () => {
      model.use(waitsForAbort());

      const controller = new AbortController();
      const running = open(a, "head-coach", controller.signal);

      await vi.waitFor(() => expect(model.calls).toHaveLength(1));

      const busy = await send(a, "head-coach", { content: "outra" });

      expect(busy.status).toBe(409);
      expect(JSON.parse(busy.body as string).error.code).toBe("CONVERSATION_BUSY");
      // The refused send stored nothing and never reached the model.
      expect(model.calls).toHaveLength(1);

      model.use(speaks(["livre"]));

      expect((await send(a, "physiologist", { content: "outro expert" })).status).toBe(200);
      expect((await send(b, "head-coach", { content: "outra pessoa" })).status).toBe(200);

      controller.abort();
      await running.then((response) => response.body?.cancel()).catch(() => undefined);
    });

    it("frees the lock when the client disconnects: the next send is accepted", async () => {
      model.use(waitsForAbort());

      const controller = new AbortController();
      const running = open(a, "head-coach", controller.signal);

      await vi.waitFor(() => expect(model.calls).toHaveLength(1));
      controller.abort();
      await running.then((response) => response.body?.cancel()).catch(() => undefined);

      model.use(speaks(["depois"]));
      await vi.waitFor(async () => {
        expect((await send(a, "head-coach", { content: "de novo" })).status).toBe(200);
      });
    });

    it("frees the lock when the model fails", async () => {
      model.use(() => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("down")) }),
      }));
      await send(a, "head-coach", { content: "falha" });

      model.use(speaks(["ok"]));

      expect((await send(a, "head-coach", { content: "outra" })).status).toBe(200);
    });
  });

  describe("DELETE /experts/:expertId/conversation (R7)", () => {
    it("answers 401 without a session", async () => {
      expect((await clear(null, "head-coach")).status).toBe(401);
    });

    it("answers 404 EXPERT_NOT_FOUND for an unknown expert", async () => {
      const response = await clear(a, "goalkeeper");

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("EXPERT_NOT_FOUND");
    });

    it("deletes the conversation with 204, is idempotent, and touches no other conversation", async () => {
      await send(a, "head-coach", { content: "um" });
      await send(a, "physiologist", { content: "dois" });
      await send(b, "head-coach", { content: "tres" });

      const first = await clear(a, "head-coach");

      expect(first.status).toBe(204);
      expect(first.text).toBe("");
      expect((await clear(a, "head-coach")).status).toBe(204);
      expect(await page(a, "head-coach")).toEqual({ messages: [], nextCursor: null });
      expect((await page(a, "physiologist")).messages).toHaveLength(2);
      expect((await page(b, "head-coach")).messages).toHaveLength(2);
    });

    it("is 204 when there was no conversation at all", async () => {
      expect((await clear(a, "head-coach")).status).toBe(204);
    });
  });

  describe("sign-out and sign-in keep the conversation (R10)", () => {
    it("still has the messages after signing out and starting a new session", async () => {
      await send(a, "head-coach", { content: "vou sair" });

      const signOut = await request(app.getHttpServer())
        .post("/api/v1/auth/sign-out")
        .set(bearer(a.token));

      expect(signOut.status).toBe(204);
      expect((await get(a, "head-coach")).status).toBe(401);

      const again = { token: (await sessions.issue(a.id)).accessToken };

      expect((await page(again, "head-coach")).messages.map((message) => message.content)).toEqual([
        "vou sair",
        "Fake answer.",
      ]);

      // The next tests keep using the first token's owner.
      a = { id: a.id, token: again.token };
    });
  });
});
