import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError } from "../../lib/api-client";
import { isAbortError, streamClient } from "../../lib/stream-client";
import { buildHistory, chatReducer, type HistoryTurn } from "./chat-state";

interface AnswerRequest {
  expertId: string;
  content: string;
  history: HistoryTurn[];
  answerId: string;
  signal: AbortSignal;
}

/** The stream ended without a `done` or `error` event: the connection dropped half way. */
class StreamInterruptedError extends Error {}

function failureStatus(error: unknown): "error" | "unavailable" | "rate-limited" {
  if (error instanceof ApiError) {
    if (error.status === 503 && error.code === "EXPERT_UNAVAILABLE") {
      return "unavailable";
    }

    if (error.status === 429) {
      return "rate-limited";
    }
  }

  return "error";
}

/**
 * The conversation with one expert, kept only in memory (it goes away with the page, or when the
 * expert changes: the caller remounts with a new `key`). `send` appends the question and streams
 * the answer into a new bubble; `stop` aborts the call; `retry` asks the last question again
 * without duplicating it. Only one answer runs at a time.
 */
export function useExpertChat(expertId: string) {
  const [messages, dispatch] = useReducer(chatReducer, []);
  const messagesRef = useRef(messages);
  const controllerRef = useRef<AbortController | null>(null);
  const idCounter = useRef(0);

  messagesRef.current = messages;

  const nextId = () => {
    idCounter.current += 1;

    return `m${idCounter.current}`;
  };

  const mutation = useMutation<void, unknown, AnswerRequest>({
    mutationFn: async ({ expertId: id, content, history, answerId, signal }) => {
      let finished = false;

      try {
        for await (const message of streamClient.post(
          `/experts/${id}/messages`,
          { content, history },
          { signal },
        )) {
          if (message.event === "delta") {
            const { text } = message.data as { text?: unknown };

            if (typeof text === "string") {
              dispatch({ type: "delta", id: answerId, text });
            }
          } else if (message.event === "done") {
            finished = true;
            dispatch({ type: "finished", id: answerId });
          } else if (message.event === "error") {
            throw new StreamInterruptedError();
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          dispatch({ type: "stopped", id: answerId });

          return;
        }

        throw error;
      }

      if (!finished) {
        throw new StreamInterruptedError();
      }
    },
    onError: (error, { answerId }) => {
      dispatch({ type: "failed", id: answerId, status: failureStatus(error) });
    },
    onSettled: () => {
      controllerRef.current = null;
    },
  });

  useEffect(
    () => () => {
      // Leaving the page or switching expert stops the call to the model.
      controllerRef.current?.abort();
    },
    [],
  );

  const { mutate } = mutation;
  const start = useCallback(
    (history: HistoryTurn[], content: string, answerId: string) => {
      const controller = new AbortController();

      controllerRef.current = controller;
      mutate({ expertId, content, history, answerId, signal: controller.signal });
    },
    [expertId, mutate],
  );

  const isAnswering = mutation.isPending;

  const send = useCallback(
    (content: string) => {
      if (controllerRef.current !== null || content.trim() === "") {
        return;
      }

      const history = buildHistory(messagesRef.current);
      const answerId = nextId();

      dispatch({ type: "sent", userId: nextId(), expertId: answerId, content });
      start(history, content, answerId);
    },
    [start],
  );

  const retry = useCallback(() => {
    const all = messagesRef.current;
    const last = all.at(-1);
    const question = all.at(-2);

    if (
      controllerRef.current !== null ||
      last?.role !== "expert" ||
      last.status === "streaming" ||
      question?.role !== "user"
    ) {
      return;
    }

    const answerId = nextId();

    dispatch({ type: "retried", id: last.id, newId: answerId });
    start(buildHistory(all.slice(0, -2)), question.content, answerId);
  }, [start]);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { messages, isAnswering, send, retry, stop };
}
