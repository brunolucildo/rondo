import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError } from "../../lib/api-client";
import { isAbortError, streamClient } from "../../lib/stream-client";
import { apiClient } from "../../lib/api-client";
import { type ChatMessage, chatReducer, type Citation } from "./chat-state";

interface AnswerRequest {
  expertId: string;
  content: string;
  /** Files attached to the message: the server searches only these. Empty searches everything. */
  connectionIds: readonly string[];
  answerId: string;
  signal: AbortSignal;
}

/** The stream ended without a `done` or `error` event: the connection dropped half way. */
class StreamInterruptedError extends Error {}

/** The server could not search the connected sources (`KNOWLEDGE_UNAVAILABLE`). */
class KnowledgeUnavailableError extends Error {}

/** Why the server refused the attached files before answering. */
export type AttachmentProblem = "not-found" | "not-ready";

export interface ExpertChatCallbacks {
  /** The server accepted the message and started to answer: the attached files were used. */
  onAccepted?: () => void;
  /** The server refused the attached files (not the user's, or not ready): nothing was sent. */
  onAttachmentProblem?: (problem: AttachmentProblem, content: string) => void;
}

function attachmentProblemOf(error: unknown): AttachmentProblem | null {
  if (error instanceof ApiError) {
    if (error.status === 404 && error.code === "CONNECTION_NOT_FOUND") {
      return "not-found";
    }

    if (error.status === 409 && error.code === "CONNECTION_NOT_READY") {
      return "not-ready";
    }
  }

  return null;
}

function failureStatus(
  error: unknown,
): "error" | "unavailable" | "rate-limited" | "busy" | "knowledge-unavailable" {
  if (error instanceof KnowledgeUnavailableError) {
    return "knowledge-unavailable";
  }

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

function isCitationList(value: unknown): value is Citation[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "sourceName" in item &&
        typeof item.sourceName === "string" &&
        "connectionId" in item &&
        typeof item.connectionId === "string",
    )
  );
}

/**
 * The conversation with one expert. It starts from what the server stored (`initialMessages`);
 * the server keeps the history from then on, so a send carries only the new text and the ids of
 * the attached files. When the expert changes the caller remounts with a new `key`. `send` appends
 * the question and streams the answer into a new bubble, with the sources the server reports at
 * the end; `stop` aborts the call (the server keeps the text received as an incomplete answer);
 * `retry` asks the last question again, with the same files, without duplicating it; `clear`
 * deletes the conversation on the server. Only one answer runs at a time.
 */
export function useExpertChat(
  expertId: string,
  initialMessages: ChatMessage[] = [],
  callbacks: ExpertChatCallbacks = {},
) {
  const [messages, dispatch] = useReducer(chatReducer, initialMessages);
  const messagesRef = useRef(messages);
  const callbacksRef = useRef(callbacks);
  const controllerRef = useRef<AbortController | null>(null);
  const lastConnectionIdsRef = useRef<readonly string[]>([]);
  const idCounter = useRef(0);

  messagesRef.current = messages;
  callbacksRef.current = callbacks;

  const nextId = () => {
    idCounter.current += 1;

    return `m${idCounter.current}`;
  };

  const mutation = useMutation<void, unknown, AnswerRequest>({
    mutationFn: async ({ expertId: id, content, connectionIds, answerId, signal }) => {
      let finished = false;
      let accepted = false;
      const body = connectionIds.length > 0 ? { content, connectionIds } : { content };

      try {
        for await (const message of streamClient.post(`/experts/${id}/messages`, body, {
          signal,
        })) {
          if (!accepted) {
            accepted = true;
            callbacksRef.current.onAccepted?.();
          }

          if (message.event === "delta") {
            const { text } = message.data as { text?: unknown };

            if (typeof text === "string") {
              dispatch({ type: "delta", id: answerId, text });
            }
          } else if (message.event === "citations") {
            const { citations } = message.data as { citations?: unknown };

            if (isCitationList(citations)) {
              dispatch({ type: "citations", id: answerId, citations });
            }
          } else if (message.event === "done") {
            finished = true;
            dispatch({ type: "finished", id: answerId });
          } else if (message.event === "error") {
            const { code } = message.data as { code?: unknown };

            throw code === "KNOWLEDGE_UNAVAILABLE"
              ? new KnowledgeUnavailableError()
              : new StreamInterruptedError();
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
    onError: (error, { answerId, content }) => {
      const problem = attachmentProblemOf(error);

      if (problem !== null) {
        // Nothing was sent: the question and the empty answer leave the list.
        dispatch({ type: "unsent", id: answerId });
        callbacksRef.current.onAttachmentProblem?.(problem, content);

        return;
      }

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
    (content: string, connectionIds: readonly string[], answerId: string) => {
      const controller = new AbortController();

      controllerRef.current = controller;
      lastConnectionIdsRef.current = connectionIds;
      mutate({ expertId, content, connectionIds, answerId, signal: controller.signal });
    },
    [expertId, mutate],
  );

  const isAnswering = mutation.isPending;

  const send = useCallback(
    (content: string, connectionIds: readonly string[] = []) => {
      if (controllerRef.current !== null || content.trim() === "") {
        return;
      }

      const answerId = nextId();

      dispatch({ type: "sent", userId: nextId(), expertId: answerId, content });
      start(content, connectionIds, answerId);
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
    start(question.content, lastConnectionIdsRef.current, answerId);
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
