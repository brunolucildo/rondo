import { YellowCardIcon } from "@repo/ui/icons";
import { useId } from "react";
import type { Citation } from "./chat-state";

/** The text of the gap notice: no connected source covers the question (interface text, en-US). */
export const NO_SOURCE_NOTICE = "No connected source covers this.";

function sourceLabel(citation: Citation): string {
  return citation.page === null
    ? citation.sourceName
    : `${citation.sourceName}, page ${citation.page}`;
}

export interface AnswerSourcesProps {
  /** `null`: no search ran, nothing to show. `[]`: the gap notice. Otherwise the sources list. */
  citations: readonly Citation[] | null;
}

/**
 * What an answer stands on, under the text of the expert: the list "Sources" (name and page of
 * each source the server used) or, when the search ran and nothing covers the question, the notice
 * "No connected source covers this." and no list. Plain semantic markup with theme tokens only, so
 * it reads the same in the light and the dark theme; the list is part of the reading order.
 */
export function AnswerSources({ citations }: AnswerSourcesProps) {
  const titleId = useId();

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
        {citations.map((citation) => (
          <li key={`${citation.connectionId}-${citation.page ?? "none"}`} className="break-words">
            {sourceLabel(citation)}
          </li>
        ))}
      </ul>
    </section>
  );
}
