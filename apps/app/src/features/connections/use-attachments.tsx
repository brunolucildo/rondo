import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useReducer,
  useRef,
  useState,
} from "react";
import { apiClient } from "../../lib/api-client";
import { uploadClient } from "../../lib/upload-client";
import {
  checkFileBeforeUpload,
  type ConnectionDto,
  describeLinkFailure,
  describeProcessingFailure,
  describeUploadFailure,
  type FailureMessage,
  linkLabel,
} from "./connection-messages";
import { PrivacyNotice } from "./privacy-notice";

const PRIVACY_KEY = "rondo.connections.privacy-accepted";
const POLL_START_MS = 1000;
const POLL_STEP_MS = 500;
const POLL_MAX_MS = 5000;

export type AttachmentPhase = "uploading" | "processing" | "ready" | "failed";

export interface AttachmentView {
  id: string;
  name: string;
  phase: AttachmentPhase;
  /** The explanation of a failure, or `null`. */
  message: string | null;
  /** True when sending the same file again can work. */
  canRetry: boolean;
}

/** What the person attached: a file, or a link. A link lives in memory only, to be sent again on retry. */
type AttachmentSource = { kind: "file"; file: File } | { kind: "link"; url: string };

interface Attachment {
  id: string;
  source: AttachmentSource;
  /** Set once the API answered; the status is then followed by polling. */
  connectionId: string | null;
  /** Why the upload itself was refused or failed. */
  rejection: FailureMessage | null;
  /** Why the server refused to use this file in an answer (set after a send that did not go). */
  problem: string | null;
}

type Action =
  | { type: "added"; attachment: Attachment }
  | { type: "sent"; id: string; connectionId: string }
  | { type: "rejected"; id: string; rejection: FailureMessage }
  | { type: "restarted"; id: string }
  | { type: "flagged"; ids: readonly string[]; problem: string }
  | { type: "removed"; id: string }
  /** The connections were deleted on the server: the chips that point at them go. */
  | { type: "dropped"; connectionIds: readonly string[] }
  | { type: "cleared"; ids: readonly string[] };

function reducer(state: readonly Attachment[], action: Action): Attachment[] {
  switch (action.type) {
    case "added":
      return [...state, action.attachment];
    case "sent":
      return state.map((item) =>
        item.id === action.id
          ? { ...item, connectionId: action.connectionId, rejection: null, problem: null }
          : item,
      );
    case "rejected":
      return state.map((item) =>
        item.id === action.id ? { ...item, rejection: action.rejection } : item,
      );
    case "restarted":
      return state.map((item) =>
        item.id === action.id
          ? { ...item, connectionId: null, rejection: null, problem: null }
          : item,
      );
    case "flagged":
      return state.map((item) =>
        action.ids.includes(item.id) ? { ...item, problem: action.problem } : item,
      );
    case "removed":
      return state.filter((item) => item.id !== action.id);
    case "dropped":
      return state.filter(
        (item) => item.connectionId === null || !action.connectionIds.includes(item.connectionId),
      );
    case "cleared":
      return state.filter((item) => !action.ids.includes(item.id));
  }
}

const PROBLEM_TEXT = {
  "not-found": "This file is no longer available. Remove it and attach it again.",
  "not-ready": "This file is not ready yet. Remove it or wait a moment and try again.",
} as const;

function readPrivacyAccepted(): boolean {
  try {
    return window.localStorage.getItem(PRIVACY_KEY) === "true";
  } catch {
    return false;
  }
}

function rememberPrivacyAccepted(): void {
  try {
    window.localStorage.setItem(PRIVACY_KEY, "true");
  } catch {
    // The notice then shows again next time; nothing else depends on it.
  }
}

/** The status query of one connection: polls from 1 s up to 5 s while it is not settled. */
function connectionQuery(connectionId: string) {
  return {
    queryKey: ["connections", connectionId] as const,
    queryFn: () => apiClient.get<ConnectionDto>(`/connections/${connectionId}`),
    // The upload answer seeds the cache; only the interval below refreshes it.
    staleTime: Infinity,
    refetchInterval: (query: {
      state: { data: ConnectionDto | undefined; dataUpdateCount: number };
    }) => {
      const status = query.state.data?.status;

      return status === "ready" || status === "failed"
        ? false
        : Math.min(POLL_START_MS + POLL_STEP_MS * query.state.dataUpdateCount, POLL_MAX_MS);
    },
  };
}

interface AttachmentsContextValue {
  attachments: readonly AttachmentView[];
  /** True while a file is uploading, processing or was refused by the server: `Send` must wait. */
  isBusy: boolean;
  addFile: (file: File) => void;
  /** Connects a link (spec 0027); the privacy notice comes first on the first use. */
  addLink: (url: string) => void;
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  /** Drops the chips that are not in progress (the message was sent). */
  clearSettled: () => void;
  /**
   * The ids of the connections of the files that are ready: what the next message carries so the
   * expert answers from them. Each connection once, even when the same file was attached twice.
   */
  readyConnectionIds: readonly string[];
  /** Marks the ready files as the cause of a refused send; the chip says what to do. */
  flagProblem: (problem: "not-found" | "not-ready") => void;
  /**
   * The connections the person deleted in this page (spec 0025). Their chips go and the sources
   * of the answers on screen that cite them read "Source removed" at once.
   */
  removedConnectionIds: ReadonlySet<string>;
  connectionsDeleted: (connectionIds: readonly string[]) => void;
}

const AttachmentsContext = createContext<AttachmentsContextValue | null>(null);

const NO_REMOVED_CONNECTIONS: ReadonlySet<string> = new Set();

function viewOf(item: Attachment, connection: ConnectionDto | undefined): AttachmentView {
  const name = item.source.kind === "file" ? item.source.file.name : linkLabel(item.source.url);
  const base = { id: item.id, name };

  if (item.rejection !== null) {
    return {
      ...base,
      phase: "failed",
      message: item.rejection.text,
      canRetry: item.rejection.retryable,
    };
  }

  if (item.problem !== null) {
    return { ...base, phase: "failed", message: item.problem, canRetry: false };
  }

  if (item.connectionId === null) {
    return { ...base, phase: "uploading", message: null, canRetry: false };
  }

  if (connection?.status === "ready") {
    return { ...base, phase: "ready", message: null, canRetry: false };
  }

  if (connection?.status === "failed") {
    const failure = describeProcessingFailure(connection.errorCode, connection.kind);

    return { ...base, phase: "failed", message: failure.text, canRetry: failure.retryable };
  }

  return { ...base, phase: "processing", message: null, canRetry: false };
}

/**
 * The files attached to the next message, with the status of each one. It lives above the chat so
 * the chips survive a change of expert. Choosing a file asks for the privacy notice first (once
 * per browser); then the file is uploaded and its status is followed until `ready` or `failed`.
 * The polling belongs to this provider's queries, so it stops when the page is left. Removing a
 * chip never deletes the connection (that is done in the panel of connections).
 */
export function AttachmentsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [items, dispatch] = useReducer(reducer, []);
  const [pendingSource, setPendingSource] = useState<AttachmentSource | null>(null);
  const [removedConnectionIds, setRemovedConnectionIds] = useState<ReadonlySet<string>>(new Set());
  const counter = useRef(0);
  const { mutateAsync } = useMutation({
    mutationFn: (source: AttachmentSource) =>
      source.kind === "file"
        ? uploadClient.postFile<ConnectionDto>("/connections", source.file)
        : apiClient.post<ConnectionDto>("/connections/url", { url: source.url }),
  });

  // One query per connection: the same file attached twice is one connection (deduplication).
  const connectionIds = [
    ...new Set(items.flatMap((item) => (item.connectionId === null ? [] : [item.connectionId]))),
  ];
  const results = useQueries({ queries: connectionIds.map(connectionQuery) });
  const connectionOf = new Map<string, ConnectionDto | undefined>(
    connectionIds.map((connectionId, position) => [connectionId, results[position]?.data]),
  );
  const views = items.map((item) =>
    viewOf(item, item.connectionId === null ? undefined : connectionOf.get(item.connectionId)),
  );

  const send = useCallback(
    async (id: string, source: AttachmentSource) => {
      try {
        const connection = await mutateAsync(source);

        queryClient.setQueryData(["connections", connection.id], connection);
        dispatch({ type: "sent", id, connectionId: connection.id });
      } catch (error) {
        dispatch({
          type: "rejected",
          id,
          rejection:
            source.kind === "file" ? describeUploadFailure(error) : describeLinkFailure(error),
        });
      }
    },
    [mutateAsync, queryClient],
  );

  const start = useCallback(
    (source: AttachmentSource) => {
      counter.current += 1;

      const id = `attachment-${counter.current}`;
      const refusal = source.kind === "file" ? checkFileBeforeUpload(source.file) : null;

      dispatch({
        type: "added",
        attachment: { id, source, connectionId: null, rejection: refusal, problem: null },
      });

      if (refusal === null) {
        void send(id, source);
      }
    },
    [send],
  );

  const addSource = useCallback(
    (source: AttachmentSource) => {
      if (readPrivacyAccepted()) {
        start(source);
      } else {
        setPendingSource(source);
      }
    },
    [start],
  );

  const addFile = useCallback((file: File) => addSource({ kind: "file", file }), [addSource]);
  const addLink = useCallback(
    (url: string) => addSource({ kind: "link", url: url.trim() }),
    [addSource],
  );

  const connectionsDeleted = useCallback(
    (deletedIds: readonly string[]) => {
      setRemovedConnectionIds((current) => new Set([...current, ...deletedIds]));
      dispatch({ type: "dropped", connectionIds: deletedIds });

      for (const connectionId of deletedIds) {
        queryClient.removeQueries({ queryKey: ["connections", connectionId], exact: true });
      }
    },
    [queryClient],
  );

  const value: AttachmentsContextValue = {
    attachments: views,
    removedConnectionIds,
    connectionsDeleted,
    // A file the server refused to use also holds the message back: sending without it would
    // silently widen the search to the whole base.
    isBusy:
      items.some((item) => item.problem !== null) ||
      views.some((view) => view.phase === "uploading" || view.phase === "processing"),
    addFile,
    addLink,
    removeAttachment: (id) => dispatch({ type: "removed", id }),
    retryAttachment: (id) => {
      const item = items.find((candidate) => candidate.id === id);

      if (item !== undefined) {
        dispatch({ type: "restarted", id });
        void send(id, item.source);
      }
    },
    readyConnectionIds: [
      ...new Set(
        items.flatMap((item, position) =>
          views[position]?.phase === "ready" && item.connectionId !== null
            ? [item.connectionId]
            : [],
        ),
      ),
    ],
    flagProblem: (problem) =>
      dispatch({
        type: "flagged",
        ids: views.filter((view) => view.phase === "ready").map((view) => view.id),
        problem: PROBLEM_TEXT[problem],
      }),
    clearSettled: () =>
      dispatch({
        type: "cleared",
        ids: views
          .filter((view) => view.phase === "ready" || view.phase === "failed")
          .map((view) => view.id),
      }),
  };

  return (
    <AttachmentsContext.Provider value={value}>
      {children}
      {pendingSource === null ? null : (
        <PrivacyNotice
          onAccept={() => {
            rememberPrivacyAccepted();
            start(pendingSource);
            setPendingSource(null);
          }}
          onCancel={() => setPendingSource(null)}
        />
      )}
    </AttachmentsContext.Provider>
  );
}

/**
 * The connections deleted in this page, for the places that only read them (the sources of an
 * answer). Unlike `useAttachments` it does not require the provider: without it nothing was deleted.
 */
export function useRemovedConnectionIds(): ReadonlySet<string> {
  return useContext(AttachmentsContext)?.removedConnectionIds ?? NO_REMOVED_CONNECTIONS;
}

export function useAttachments(): AttachmentsContextValue {
  const value = useContext(AttachmentsContext);

  if (value === null) {
    throw new Error("useAttachments must be used inside AttachmentsProvider.");
  }

  return value;
}
