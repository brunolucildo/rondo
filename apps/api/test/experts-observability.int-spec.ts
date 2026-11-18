import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/bootstrap";
import { SessionService } from "../src/modules/auth/application/services/session.service";
import { EXPERT_ORCHESTRATOR } from "../src/modules/experts";
import type { ExpertOrchestrator } from "../src/modules/experts/domain/expert-ports";
import { DEFAULT_RETRIEVAL_MIN_SCORE } from "../src/modules/experts/domain/expert-retrieval-config";
import { KnowledgeIndexRetriever } from "../src/modules/experts/infrastructure/knowledge-index-retriever";
import { LangGraphExpertOrchestrator } from "../src/modules/experts/infrastructure/langgraph-expert-orchestrator";
import {
  SCRIPTED_FAIL_MARKER,
  SCRIPTED_SLOW_MARKER,
  ScriptedChatModel,
} from "../src/modules/experts/infrastructure/scripted-chat-model";
import { EMBEDDINGS_GENERATOR, KNOWLEDGE_INDEX } from "../src/modules/knowledge";
import {
  InstrumentedEmbeddingsGenerator,
  InstrumentedKnowledgeIndex,
} from "../src/modules/knowledge/infrastructure/instrumented";
import {
  FakeEmbeddingsGenerator,
  fakeVectorOf,
  InMemoryKnowledgeIndex,
} from "../src/modules/knowledge/testing";
import { baseLogger } from "../src/observability/logger";
import {
  assertMigrationsApplied,
  deleteUsersByEmail,
  query,
  rows,
  sha256,
} from "./support/database";
import { resetRateLimitStore } from "./support/rate-limit";
import { seedConfirmedUser } from "./support/sessions";
import { answerText, parseSse, readText } from "./support/sse";
import { startTelemetryRecorder, type TelemetryRecorder } from "./support/telemetry";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

type LogFields = Record<string, unknown>;

/** Every value that identifies a person, a file or the content: none may reach any signal. */
const SENTINEL_QUESTION = "SENTINEL-question-6a31 how is the squad load this week?";
const SENTINEL_ANSWER = "SENTINEL-answer-92cc the load is fine.";
const SENTINEL_DOCUMENT = "SENTINEL-document-text-41de";
const SENTINEL_FILE = "SENTINEL-file-name-7b0f.pdf";

/** A chat model that fails like a provider does: with an HTTP status and a message that echoes the prompt. */
class StatusFailingModel extends BaseChatModel {
  constructor(private readonly status: number) {
    super({});
  }

  _llmType(): string {
    return "status-failing";
  }

  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    return Promise.reject(
      Object.assign(new Error(`provider echoed the prompt: ${String(messages[0]?.content)}`), {
        status: this.status,
      }),
    );
  }
}

/**
 * The real API with the real graph, the real retrieval and the instrumented embeddings and index
 * (in memory, so no Weaviate), on top of the scripted chat model: no network, no OpenAI. It checks
 * the spans, metrics and logs the agent emits (spec 0029): the tree, the closed labels, the tokens,
 * the first token, the correlation and that no content leaves the process.
 */
describe("experts agent observability (real API, in-memory OpenTelemetry)", () => {
  const createdEmails: string[] = [];
  const createdUserIds: string[] = [];
  /** Spans, metrics and logs of every test, as text, for the final leak check. */
  const artifacts: string[] = [];
  const index = new InstrumentedKnowledgeIndex(new InMemoryKnowledgeIndex());
  const embeddings = new InstrumentedEmbeddingsGenerator(new FakeEmbeddingsGenerator());
  const spies = {
    info: vi.spyOn(baseLogger, "info"),
    warn: vi.spyOn(baseLogger, "warn"),
    error: vi.spyOn(baseLogger, "error"),
  };
  const orchestrators: { current: ExpertOrchestrator | null } = { current: null };
  let recorder: TelemetryRecorder;
  let app: INestApplication;
  let owner: { id: string; token: string };
  let graph: LangGraphExpertOrchestrator;

  // pino-http logs the raw request and response; only what its serializers keep is written.
  const logs = (): LogFields[] =>
    Object.values(spies).flatMap((spy) =>
      spy.mock.calls.map(([fields]) => {
        const { req: _req, res: _res, ...written } = (fields ?? {}) as LogFields;

        return written;
      }),
    );
  const logsOf = (event: string) => logs().filter((fields) => fields.event === event);
  const spansNamed = (name: string) => recorder.spans().filter((span) => span.name === name);
  const parentOf = (span: { parentSpanContext?: { spanId: string } }) =>
    span.parentSpanContext?.spanId;
  const idOf = (span: { spanContext(): { spanId: string } }) => span.spanContext().spanId;

  async function newUser(label: string) {
    const user = await seedConfirmedUser(label, { firstName: "Sentinelle", lastName: "Fortescue" });

    createdEmails.push(user.email);
    createdUserIds.push(user.id);

    return { id: user.id, token: (await app.get(SessionService).issue(user.id)).accessToken };
  }

  /** A `ready` connection of the user with one chunk in the index. */
  async function seedConnection(userId: string, text: string, name = SENTINEL_FILE) {
    const [created] = await rows<{ id: string }>(
      `insert into public.connections (user_id, kind, name, size_bytes, content_hash, status, chunk_count)
       values ($1, 'pdf', $2, 10, $3, 'ready', 1) returning id`,
      [userId, name, sha256(randomUUID())],
    );
    const connectionId = created?.id ?? "";

    await index.upsert(userId, [
      { connectionId, sourceName: name, position: 0, text, vector: fakeVectorOf(text) },
    ]);

    return connectionId;
  }

  const send = (body: unknown, expertId = "head-coach") =>
    request(app.getHttpServer())
      .post(`/api/v1/experts/${expertId}/messages`)
      .set(bearer(owner.token))
      .buffer(true)
      .parse(readText)
      .send(body as object);

  const useModel = (model: BaseChatModel) => {
    orchestrators.current = new LangGraphExpertOrchestrator(
      model,
      new KnowledgeIndexRetriever(embeddings, index, {
        maxChunks: 6,
        minScore: DEFAULT_RETRIEVAL_MIN_SCORE,
      }),
    );
  };

  beforeAll(async () => {
    await assertMigrationsApplied();
    recorder = startTelemetryRecorder();
    useModel(new ScriptedChatModel({}));
    graph = orchestrators.current as LangGraphExpertOrchestrator;

    const orchestrator: ExpertOrchestrator = {
      available: true,
      answer: (input) => (orchestrators.current ?? graph).answer(input),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDINGS_GENERATOR)
      .useValue(embeddings)
      .overrideProvider(KNOWLEDGE_INDEX)
      .useValue(index)
      .overrideProvider(EXPERT_ORCHESTRATOR)
      .useValue(orchestrator)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    owner = await newUser("agent-observability");
  });

  afterAll(async () => {
    await Promise.all(createdUserIds.map((id) => index.deleteAllForUser(id)));
    await app.close();
    await recorder.stop();
    await deleteUsersByEmail(createdEmails);
  });

  /**
   * Clears what the recorder holds. `reset()` alone keeps the points the meter has not collected
   * yet (the cleanup below and the seeding are calls to the index too), so collect first.
   */
  const clearSignals = async () => {
    await recorder.metric("expert.grounded");
    recorder.reset();

    for (const spy of Object.values(spies)) {
      spy.mockClear();
    }
  };

  beforeEach(async () => {
    resetRateLimitStore(app);
    useModel(new ScriptedChatModel({}));

    await query("delete from public.expert_conversations where user_id = $1", [owner.id]);
    await query("delete from public.connections where user_id = $1", [owner.id]);
    await index.deleteAllForUser(owner.id);
    await clearSignals();
  });

  afterEach(async () => {
    artifacts.push(
      JSON.stringify({
        spans: recorder.exportedSpans(),
        metrics: await Promise.all(
          [
            "expert.message.duration",
            "expert.first_token",
            "expert.llm.tokens",
            "expert.retrieval.hits",
            "expert.grounded",
            "expert.dependency.calls",
          ].map((name) => recorder.metric(name)),
        ),
        logs: JSON.parse(
          JSON.stringify(logs(), (_key, value: unknown) => value ?? null),
        ) as unknown,
      }),
    );
  });

  describe("traces (R1)", () => {
    it("shows the tree: message -> retrieve -> retrieval -> embeddings and index, and generate -> LLM", async () => {
      await seedConnection(owner.id, SENTINEL_QUESTION);

      const response = await send({ content: SENTINEL_QUESTION });

      expect(response.status).toBe(200);
      expect(parseSse(response.body as string).at(-1)).toEqual({ event: "done", data: {} });

      const [message] = spansNamed("expert.message");
      const [retrieve] = spansNamed("expert.retrieve");
      const [retrieval] = spansNamed("expert.retrieval");
      const [generate] = spansNamed("expert.generate");
      const [embeddingsSpan] = spansNamed("gen_ai.embeddings");
      const [search] = spansNamed("knowledge.index.search");
      const [llm] = spansNamed("gen_ai.chat");

      expect(message).toBeDefined();
      expect(parentOf(retrieve!)).toBe(idOf(message!));
      expect(parentOf(generate!)).toBe(idOf(message!));
      expect(parentOf(retrieval!)).toBe(idOf(retrieve!));
      expect(parentOf(embeddingsSpan!)).toBe(idOf(retrieval!));
      expect(parentOf(search!)).toBe(idOf(retrieval!));
      expect(parentOf(llm!)).toBe(idOf(generate!));
      // Calls to something outside the process are CLIENT spans (kind 2).
      expect([embeddingsSpan, search, llm].map((span) => span?.kind)).toEqual([2, 2, 2]);
      expect(search?.attributes).toMatchObject({ "db.system.name": "weaviate" });
      expect(llm?.attributes).toMatchObject({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.usage.input_tokens": 12,
      });
      expect(recorder.spans().every((span) => span.status.code !== 2)).toBe(true);
      expect(message?.attributes).toMatchObject({
        "expert.id": "head-coach",
        "expert.outcome": "success",
      });
      expect(message?.attributes).not.toHaveProperty("expert.error_code");
    });

    it("marks a failed LLM call as an error with the closed code, and nothing else", async () => {
      const response = await send({ content: `quebre ${SCRIPTED_FAIL_MARKER}` });

      expect(parseSse(response.body as string)).toEqual([
        {
          event: "error",
          data: { code: "EXPERT_ANSWER_FAILED", message: "The expert couldn't answer." },
        },
      ]);

      const [message] = spansNamed("expert.message");

      expect(message?.status.code).toBe(2);
      expect(message?.attributes).toMatchObject({
        "expert.outcome": "failure",
        "expert.error_code": "provider_error",
      });

      for (const name of ["expert.generate", "gen_ai.chat"]) {
        for (const span of spansNamed(name)) {
          expect(span.status.code, name).toBe(2);
          expect(span.attributes["expert.error_code"], name).toBe("unknown");
          expect(span.events, name).toEqual([]);
        }
      }
    });

    it("maps the provider status to a closed code (429 -> rate_limited) and logs the failed dependency", async () => {
      useModel(new StatusFailingModel(429));

      await send({ content: SENTINEL_QUESTION });

      expect(spansNamed("gen_ai.chat")[0]?.attributes).toMatchObject({
        "expert.error_code": "rate_limited",
      });
      expect(logsOf("expert_dependency_failed")[0]).toMatchObject({
        dependency: "openai",
        reason: "rate_limited",
      });
    });

    it("does not mark a Stop as an error: outcome aborted, status not ERROR", async () => {
      const server = app.getHttpServer();

      await app.listen(0);

      const { port } = server.address() as AddressInfo;
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/experts/head-coach/messages`, {
        method: "POST",
        headers: { ...bearer(owner.token), "content-type": "application/json" },
        body: JSON.stringify({ content: `devagar ${SCRIPTED_SLOW_MARKER}` }),
        signal: controller.signal,
      });
      const reader = response.body?.getReader();

      await reader?.read();
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      await vi.waitFor(() => expect(logsOf("expert_message")).toHaveLength(1), { timeout: 5000 });

      const [message] = spansNamed("expert.message");

      expect(message?.attributes).toMatchObject({ "expert.outcome": "aborted" });
      expect(message?.attributes).not.toHaveProperty("expert.error_code");
      expect(recorder.spans().filter((span) => span.status.code === 2)).toEqual([]);
      expect((await recorder.metric("expert.message.duration")).map((p) => p.attributes)).toEqual([
        { expert: "head-coach", outcome: "aborted" },
      ]);
      // A stop is not a failed call to the provider.
      expect(logsOf("expert_dependency_failed")).toEqual([]);
    });
  });

  describe("metrics (R3, R4)", () => {
    it("emits the series of two experts with exactly the closed labels", async () => {
      await seedConnection(owner.id, SENTINEL_QUESTION);
      await send({ content: SENTINEL_QUESTION }, "head-coach");
      await send({ content: "Anything else?" }, "physiologist");
      await send({ content: `quebre ${SCRIPTED_FAIL_MARKER}` }, "physiologist");

      const keysOf = async (name: string) =>
        (await recorder.metric(name)).map((point) => Object.keys(point.attributes).sort());

      for (const name of ["expert.message.duration"]) {
        for (const keys of await keysOf(name)) {
          expect(keys, name).toEqual(["expert", "outcome"]);
        }
      }

      for (const keys of await keysOf("expert.first_token")) {
        expect(keys).toEqual(["expert"]);
      }

      for (const keys of await keysOf("expert.llm.tokens")) {
        expect(keys).toEqual(["direction", "expert"]);
      }

      for (const keys of await keysOf("expert.retrieval.hits")) {
        expect(keys).toEqual(["scope"]);
      }

      for (const keys of await keysOf("expert.grounded")) {
        expect(keys).toEqual(["grounded"]);
      }

      for (const keys of await keysOf("expert.dependency.calls")) {
        expect(keys).toEqual(["dependency", "outcome"]);
      }

      const durations = (await recorder.metric("expert.message.duration")).map((point) => [
        point.attributes.expert,
        point.attributes.outcome,
        point.value,
      ]);

      expect(durations.sort()).toEqual([
        ["head-coach", "success", 1],
        ["physiologist", "failure", 1],
        ["physiologist", "success", 1],
      ]);
      // The unit is seconds: the largest bucket reaches the 120 s timeout, not 10000 ms.
      expect((await recorder.metric("expert.message.duration"))[0]?.boundaries?.at(-1)).toBe(120);
    });

    it("counts the tokens the provider reported and the first token once per message", async () => {
      await send({ content: "Olá" }, "head-coach");

      const tokens = await recorder.metric("expert.llm.tokens");
      const byDirection = Object.fromEntries(
        tokens.map((point) => [point.attributes.direction as string, point.value]),
      );

      expect(byDirection.input).toBe(12);
      expect(byDirection.output).toBeGreaterThan(3);

      const [firstToken] = await recorder.metric("expert.first_token");

      expect(firstToken?.attributes).toEqual({ expert: "head-coach" });
      expect(firstToken?.value).toBe(1);
      expect(firstToken?.sum).toBeGreaterThan(0);
    });

    it("does not count tokens when the provider reports no usage, and logs expert_usage_unavailable", async () => {
      useModel(
        new FakeStreamingChatModel({ chunks: [new AIMessageChunk({ content: SENTINEL_ANSWER })] }),
      );

      const response = await send({ content: "Olá" });

      expect(answerText(parseSse(response.body as string))).toBe(SENTINEL_ANSWER);
      expect(await recorder.metric("expert.llm.tokens")).toEqual([]);
      expect(logsOf("expert_usage_unavailable")).toHaveLength(1);
      expect(logsOf("expert_message")[0]).toMatchObject({
        inputTokens: null,
        outputTokens: null,
      });
    });

    it("counts the answer as grounded, a gap or skipped, and the hits of the retrieval", async () => {
      // No connection: nothing is retrieved.
      await send({ content: "Olá" });
      // A connection that does not cover the question: the retrieval runs and finds nothing.
      await seedConnection(owner.id, "completely unrelated text about the stadium roof");
      await send({ content: "tell me about the squad load" });
      // A connection that covers it.
      await seedConnection(owner.id, SENTINEL_QUESTION);
      await send({ content: SENTINEL_QUESTION });

      const grounded = Object.fromEntries(
        (await recorder.metric("expert.grounded")).map((point) => [
          point.attributes.grounded as string,
          point.value,
        ]),
      );

      expect(grounded).toEqual({ skipped: 1, gap: 1, yes: 1 });

      const hits = await recorder.metric("expert.retrieval.hits");

      expect(hits.map((point) => point.attributes)).toEqual([{ scope: "all" }]);
      expect(hits[0]?.value).toBe(2);
      expect(hits[0]?.sum).toBe(1);
    });

    it("counts the calls to OpenAI (embeddings and chat) and to Weaviate (search)", async () => {
      await seedConnection(owner.id, SENTINEL_QUESTION);
      await clearSignals();
      await send({ content: SENTINEL_QUESTION });

      const calls = Object.fromEntries(
        (await recorder.metric("expert.dependency.calls")).map((point) => [
          `${String(point.attributes.dependency)}|${String(point.attributes.outcome)}`,
          point.value,
        ]),
      );

      expect(calls).toEqual({ "openai|success": 2, "weaviate|success": 1 });
    });
  });

  describe("correlation (R5)", () => {
    it("gives the expert_message and expert_retrieval logs the trace and span ids of their spans", async () => {
      await seedConnection(owner.id, SENTINEL_QUESTION);
      await send({ content: SENTINEL_QUESTION });

      const [message] = spansNamed("expert.message");
      const [retrieval] = spansNamed("expert.retrieval");
      const [messageLog] = logsOf("expert_message");
      const [retrievalLog] = logsOf("expert_retrieval");

      expect(messageLog).toMatchObject({
        trace_id: message?.spanContext().traceId,
        span_id: message?.spanContext().spanId,
      });
      expect(retrievalLog).toMatchObject({
        trace_id: retrieval?.spanContext().traceId,
        span_id: retrieval?.spanContext().spanId,
      });
      expect(retrieval?.spanContext().traceId).toBe(message?.spanContext().traceId);
    });
  });

  describe("no content in any signal (R2)", () => {
    it("keeps the question, the answer, the document and the file name out of spans, metrics and logs", async () => {
      const connectionId = await seedConnection(
        owner.id,
        `${SENTINEL_QUESTION} ${SENTINEL_DOCUMENT}`,
      );

      // Success with a source, gap, failure and Stop, plus a model that answers with the sentinel.
      await send({ content: `${SENTINEL_QUESTION} ${SENTINEL_DOCUMENT}` });
      await send({ content: `${SENTINEL_QUESTION} nothing about it` });
      await send({ content: `${SENTINEL_QUESTION} ${SCRIPTED_FAIL_MARKER}` });
      useModel(
        new FakeStreamingChatModel({ chunks: [new AIMessageChunk({ content: SENTINEL_ANSWER })] }),
      );
      await send({ content: SENTINEL_QUESTION });
      useModel(new StatusFailingModel(503));
      await send({ content: SENTINEL_QUESTION });

      const everything = JSON.stringify({
        spans: recorder.exportedSpans(),
        metrics: await Promise.all(
          [
            "expert.message.duration",
            "expert.first_token",
            "expert.llm.tokens",
            "expert.retrieval.hits",
            "expert.grounded",
            "expert.dependency.calls",
            "expert.retrieval.duration",
            "expert.retrievals",
            "knowledge.index.operation.duration",
            "knowledge.embeddings.duration",
          ].map((name) => recorder.metric(name)),
        ),
        logs: logs().map((fields) => JSON.stringify(fields, (_k, value: unknown) => value ?? null)),
      });

      expect(everything).toContain("expert_message");
      expect(everything).toContain("gen_ai.chat");

      for (const secret of [
        SENTINEL_QUESTION,
        "SENTINEL-question",
        SENTINEL_ANSWER,
        "SENTINEL-answer",
        SENTINEL_DOCUMENT,
        SENTINEL_FILE,
        "SENTINEL-file-name",
        owner.id,
        connectionId,
        owner.token,
        "provider echoed the prompt",
      ]) {
        expect(everything, `a signal contains "${secret.slice(0, 16)}..."`).not.toContain(secret);
      }
    });
  });

  it("never leaks a sentinel across the whole file (final check)", () => {
    expect(artifacts.length).toBeGreaterThan(0);

    const everything = artifacts.join("\n");

    for (const secret of [
      "SENTINEL-question",
      "SENTINEL-answer",
      "SENTINEL-document",
      "SENTINEL-file-name",
      owner.id,
      owner.token,
    ]) {
      expect(everything, `a signal contains "${secret.slice(0, 16)}..."`).not.toContain(secret);
    }
  });
});

/**
 * The LangChain tracing to LangSmith is on by an environment variable, even one inherited from the
 * developer's machine. The API turns it off at boot (R8): no request reaches a (fake) LangSmith.
 */
describe("LangSmith tracing lock (R8)", () => {
  const SWITCHES = ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"] as const;
  const SETTINGS = ["LANGSMITH_API_KEY", "LANGSMITH_ENDPOINT"] as const;
  const requests: string[] = [];
  const createdEmails: string[] = [];
  let langsmith: Server;
  let endpoint: string;
  let recorder: TelemetryRecorder;
  let app: INestApplication | undefined;

  const answer = async (guarded: boolean) => {
    if (!guarded) {
      // Control: the graph built straight, without the boot lock, does talk to LangSmith.
      const events: unknown[] = [];

      for await (const event of new LangGraphExpertOrchestrator(new ScriptedChatModel({})).answer({
        expertId: "head-coach",
        messages: [{ role: "user", content: "Olá" }],
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);

      return;
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const user = await seedConfirmedUser("langsmith-lock");

    createdEmails.push(user.email);

    const token = (await app.get(SessionService).issue(user.id)).accessToken;
    const response = await request(app.getHttpServer())
      .post("/api/v1/experts/head-coach/messages")
      .set(bearer(token))
      .buffer(true)
      .parse(readText)
      .send({ content: "Olá, sem arquivos" });

    expect(parseSse(response.body as string).at(-1)).toEqual({ event: "done", data: {} });
  };

  beforeAll(async () => {
    await assertMigrationsApplied();
    recorder = startTelemetryRecorder();
    langsmith = createServer((incoming, outgoing) => {
      requests.push(`${incoming.method} ${incoming.url}`);
      incoming.resume();
      outgoing.setHeader("content-type", "application/json");
      outgoing.end("{}");
    });
    await new Promise<void>((resolve) => langsmith.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(langsmith.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => langsmith.close(resolve));
    await recorder.stop();
    await deleteUsersByEmail(createdEmails);
  });

  beforeEach(() => {
    requests.length = 0;
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_SENTINEL_fake_key";
    process.env.LANGSMITH_ENDPOINT = endpoint;
    vi.spyOn(baseLogger, "warn");
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;

    for (const name of [...SWITCHES, ...SETTINGS]) {
      delete process.env[name];
    }

    vi.restoreAllMocks();
  });

  it("boots with the switch on, turns it off, logs the event and sends zero requests", async () => {
    const warn = vi.mocked(baseLogger.warn);

    await answer(true);
    // Runs are posted in the background in batches: give any of them time to leave.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(requests).toEqual([]);
    expect(process.env.LANGSMITH_TRACING).toBe("false");
    expect(process.env.LANGCHAIN_TRACING_V2).toBe("false");
    expect(process.env.LANGSMITH_API_KEY).toBeUndefined();

    const event = warn.mock.calls
      .map(([fields]) => fields as LogFields)
      .find((fields) => fields?.event === "langsmith_tracing_disabled");

    expect(event).toEqual({
      event: "langsmith_tracing_disabled",
      variables: ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("lsv2_SENTINEL_fake_key");
  }, 20_000);

  it("control: with the tracing switch on and no lock, a graph run does reach LangSmith", async () => {
    await answer(false);
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 8000 });
    // Let the rest of the batch leave before the server closes.
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }, 20_000);
});
