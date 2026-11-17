import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError } from "../../lib/api-client";
import { isAbortError, streamClient } from "../../lib/stream-client";
import { apiClient } from "../../lib/api-client";
import { type ChatMessage, chatReducer } from "./chat-state";

interface AnswerRequest {
  expertId: string;
  content: string;
  answerId: string;
  signal: AbortSignal;
}

/** The stream ended without a `done` or `error` event: the connection dropped half way. */
class StreamInterruptedError extends Error {}

function failureStatus(error: unknown): "error" | "unavailable" | "rate-limited" | "busy" {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === "CONVERSATION_BUSY") {
      return "busy";
    }

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
 * The conversation with one expert. It starts from what the server stored (`initialMessages`);
 * the server keeps the history from then on, so a send carries only the new text. When the expert
 * changes the caller remounts with a new `key`. `send` appends the question and streams the
 * answer into a new bubble; `stop` aborts the call (the server keeps the text received as an
 * incomplete answer); `retry` asks the last question again without duplicating it; `clear`
 * deletes the conversation on the server. Only one answer runs at a time.
 */
export function useExpertChat(expertId: string, initialMessages: ChatMessage[] = []) {
  const [messages, dispatch] = useReducer(chatReducer, initialMessages);
  const messagesRef = useRef(messages);
  const controllerRef = useRef<AbortController | null>(null);
  const idCounter = useRef(0);

  messagesRef.current = messages;

  const nextId = () => {
    idCounter.current += 1;

    return `m${idCounter.current}`;
  };

  const mutation = useMutation<void, unknown, AnswerRequest>({
    mutationFn: async ({ expertId: id, content, answerId, signal }) => {
      let finished = false;

      try {
        for await (const message of streamClient.post(
          `/experts/${id}/messages`,
          { content },
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
    (content: string, answerId: string) => {
      const controller = new AbortController();

      controllerRef.current = controller;
      mutate({ expertId, content, answerId, signal: controller.signal });
    },
    [expertId, mutate],
  );

  const isAnswering = mutation.isPending;

  const send = useCallback(
    (content: string) => {
      if (controllerRef.current !== null || content.trim() === "") {
        return;
      }

      const answerId = nextId();

      dispatch({ type: "sent", userId: nextId(), expertId: answerId, content });
      start(content, answerId);
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
    start(question.content, answerId);
  }, [start]);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const clearMutation = useMutation<void, unknown, void>({
    mutationFn: () => apiClient.delete(`/experts/${expertId}/conversation`),
    onSuccess: () => dispatch({ type: "cleared" }),
  });

  return {
    messages,
    isAnswering,
    send,
    retry,
    stop,
    clear: () => clearMutation.mutate(),
    isClearing: clearMutation.isPending,
    clearFailed: clearMutation.isError,
    resetClear: clearMutation.reset,
  };
}
