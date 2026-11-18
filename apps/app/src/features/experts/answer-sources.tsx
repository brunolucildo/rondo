import { YellowCardIcon } from "@repo/ui/icons";
import { useId } from "react";
import { formatTimestamp } from "../connections/connection-messages";
import { useRemovedConnectionIds } from "../connections/use-attachments";
import type { AnswerCitation, Citation } from "./chat-state";

/** The text of the gap notice: no connected source covers the question (interface text, en-US). */
export const NO_SOURCE_NOTICE = "No connected source covers this.";

/** What a source reads once its connection was deleted: no name, no page (spec 0025). */
export const SOURCE_REMOVED = "Source removed";

function sourceLabel(citation: Citation): string {
  // An audio or a video says the instant the passage starts: "analysis.mp4 · 12:30".
  if (citation.startSeconds !== undefined) {
    return `${citation.sourceName} · ${formatTimestamp(citation.startSeconds)}`;
  }

  return citation.page === null
    ? citation.sourceName
    : `${citation.sourceName}, page ${citation.page}`;
}

/** One line of the list: a live source, or "Source removed" once per deleted connection. */
type SourceLine = { key: string; text: string };

function sourceLines(
  citations: readonly AnswerCitation[],
  removedHere: ReadonlySet<string>,
): SourceLine[] {
  const lines: SourceLine[] = [];
  const removedSeen = new Set<string>();

  for (const citation of citations) {
    if (citation.removed === true || removedHere.has(citation.connectionId)) {
      if (!removedSeen.has(citation.connectionId)) {
        removedSeen.add(citation.connectionId);
        lines.push({ key: `removed-${citation.connectionId}`, text: SOURCE_REMOVED });
      }
    } else {
      lines.push({
        key: `${citation.connectionId}-${citation.page ?? "none"}-${citation.startSeconds ?? "none"}`,
        text: sourceLabel(citation),
      });
    }
  }

  return lines;
}

export interface AnswerSourcesProps {
  /** `null`: no search ran, nothing to show. `[]`: the gap notice. Otherwise the sources list. */
  citations: readonly AnswerCitation[] | null;
}

/**
 * What an answer stands on, under the text of the expert: the list "Sources" (name and page of
 * each source the server used) or, when the search ran and nothing covers the question, the notice
 * "No connected source covers this." and no list. A source whose connection was deleted reads
 * "Source removed", with no name (also at once for the ones deleted in this page). Plain semantic markup with theme tokens only, so
 * it reads the same in the light and the dark theme; the list is part of the reading order.
 */
export function AnswerSources({ citations }: AnswerSourcesProps) {
  const titleId = useId();
  const removedHere = useRemovedConnectionIds();

  if (citations === null) {
    return null;
  }

  if (citations.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm font-bold">
        <YellowCardIcon className="h-5 w-4 shrink-0" />
        {NO_SOURCE_NOTICE}
      </p>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-md border-2 border-border bg-background px-3 py-2 text-sm text-foreground"
    >
      <p id={titleId} className="font-bold">
        Sources
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {sourceLines(citations, removedHere).map((line) => (
          <li key={line.key} className="break-words">
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
