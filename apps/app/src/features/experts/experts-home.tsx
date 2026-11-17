import { Alert } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { useState } from "react";
import { AttachmentsProvider } from "../connections/use-attachments";
import { ExpertChat } from "./expert-chat";
import { useExperts } from "./use-experts";

const DEFAULT_EXPERT_ID = "head-coach";

/** Heading of the page for assistive technology; the visible content is the chat itself. */
function PageHeading() {
  return <h1 className="sr-only">Chat with the experts</h1>;
}

/** Placeholder of the bar and the panel while the catalog loads. Announced as a status. */
function ExpertsLoading() {
  return (
    <div role="status" className="flex flex-1 flex-col">
      <span className="sr-only">Loading the experts…</span>
      <div aria-hidden="true" className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <div className="mx-auto h-24 w-24 animate-pulse rounded-md border-2 border-border bg-muted motion-reduce:animate-none" />
        <div className="mx-auto mt-6 h-6 w-48 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
      <div
        aria-hidden="true"
        className="sticky bottom-0 border-t-2 border-border bg-card px-4 py-3"
      >
        <div className="mx-auto h-24 w-full max-w-3xl animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
    </div>
  );
}

function ExpertsLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-6">
      <Alert variant="error">We couldn&apos;t load the experts.</Alert>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </main>
  );
}

/**
 * The home of `/app`: the chat with the experts. It loads the catalog and holds the two things
 * that outlive a conversation: which expert is selected (only for this page, `head-coach` first)
 * and the text being typed.
 */
function ExpertsHomeContent() {
  const experts = useExperts();
  const [selectedId, setSelectedId] = useState(DEFAULT_EXPERT_ID);
  const [draft, setDraft] = useState("");

  if (experts.isError) {
    return (
      <>
        <PageHeading />
        <ExpertsLoadError onRetry={() => void experts.refetch()} />
      </>
    );
  }

  if (experts.data === undefined) {
    return (
      <>
        <PageHeading />
        <ExpertsLoading />
      </>
    );
  }

  const expert = experts.data.find((candidate) => candidate.id === selectedId) ?? experts.data[0];

  if (expert === undefined) {
    return (
      <>
        <PageHeading />
        <ExpertsLoadError onRetry={() => void experts.refetch()} />
      </>
    );
  }

  return (
    <>
      <PageHeading />
      <ExpertChat
        key={expert.id}
        experts={experts.data}
        expert={expert}
        onSelectExpert={setSelectedId}
        draft={draft}
        onDraftChange={setDraft}
      />
    </>
  );
}

/** The chat and the files attached to the next message (they outlive a change of expert). */
export function ExpertsHome() {
  return (
    <AttachmentsProvider>
      <ExpertsHomeContent />
    </AttachmentsProvider>
  );
}
