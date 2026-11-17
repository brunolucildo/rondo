import { Alert } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { useEffect, useRef } from "react";
import { type ChatMessage, fromStoredMessages } from "./chat-state";
import { ClearConversation } from "./clear-conversation";
import { Composer } from "./composer";
import { ExpertIntro } from "./expert-intro";
import { MessageList } from "./message-list";
import { useConversation } from "./use-conversation";
import { useExpertChat } from "./use-expert-chat";
import type { Expert } from "./use-experts";

/** Pixels from the bottom of the page within which the view keeps following the answer. */
const FOLLOW_DISTANCE_PX = 120;

export interface ExpertChatProps {
  experts: readonly Expert[];
  expert: Expert;
  onSelectExpert: (expertId: string) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
}

/** Placeholder of the list while the stored conversation loads. Announced as a status. */
function ConversationLoading() {
  return (
    <div role="status" className="mx-auto w-full max-w-3xl flex-1 space-y-5 px-4 py-6">
      <span className="sr-only">Loading the conversation…</span>
      <div aria-hidden="true" className="space-y-5">
        <div className="ml-auto h-12 w-2/3 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-20 w-5/6 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="ml-auto h-12 w-1/2 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      </div>
    </div>
  );
}

interface ExpertConversationProps extends ExpertChatProps {
  initialMessages: ChatMessage[];
}

/**
 * The conversation on screen, starting from what the server stored. It scrolls to the last message
 * on arrival and follows the answer while it streams, unless the person scrolled up to read.
 */
function ExpertConversation({
  experts,
  expert,
  onSelectExpert,
  draft,
  onDraftChange,
  initialMessages,
}: ExpertConversationProps) {
  const chat = useExpertChat(expert.id, initialMessages);
  const endRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      const { scrollHeight, scrollTop, clientHeight } = document.documentElement;

      followRef.current = scrollHeight - scrollTop - clientHeight < FOLLOW_DISTANCE_PX;
    };

    window.addEventListener("scroll", onScroll, { passive: true });

    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Keeps the newest text in view, unless the person scrolled up to read. No smooth scrolling.
  // On the first render it takes the list to the last stored message.
  useEffect(() => {
    if (chat.messages.length > 0 && followRef.current) {
      endRef.current?.scrollIntoView?.({ block: "end" });
    }
  }, [chat.messages]);

  function ask(question: string) {
    followRef.current = true;
    chat.send(question);
  }

  return (
    <>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-6">
        {chat.messages.length === 0 ? (
          <ExpertIntro expert={expert} onAsk={ask} disabled={chat.isAnswering} />
        ) : (
          <ClearConversation
            expertName={expert.name}
            disabled={chat.isAnswering}
            isClearing={chat.isClearing}
            failed={chat.clearFailed}
            onConfirm={chat.clear}
            onCancel={chat.resetClear}
          />
        )}
        <MessageList
          expert={expert}
          messages={chat.messages}
          isAnswering={chat.isAnswering}
          onRetry={chat.retry}
        />
        <div ref={endRef} />
      </main>
      <Composer
        experts={experts}
        expert={expert}
        onSelectExpert={onSelectExpert}
        draft={draft}
        onDraftChange={onDraftChange}
        isAnswering={chat.isAnswering}
        onSend={ask}
        onStop={chat.stop}
      />
    </>
  );
}

/**
 * The conversation with one expert. The parent gives it `key={expert.id}`, so choosing another
 * expert unmounts it: the answer in progress is aborted (the server keeps what arrived), the
 * request for the stored conversation is cancelled, and the conversation of the new expert loads.
 * The typed draft lives in the parent and survives the switch.
 */
export function ExpertChat(props: ExpertChatProps) {
  const conversation = useConversation(props.expert.id);

  if (conversation.isError) {
    return (
      <>
        <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-6">
          <Alert variant="error">We couldn&apos;t load the conversation.</Alert>
          <Button variant="outline" onClick={() => void conversation.refetch()}>
            Try again
          </Button>
        </main>
        <Composer
          experts={props.experts}
          expert={props.expert}
          onSelectExpert={props.onSelectExpert}
          draft={props.draft}
          onDraftChange={props.onDraftChange}
          isAnswering={false}
          disabled
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </>
    );
  }

  if (conversation.data === undefined) {
    return (
      <>
        <ConversationLoading />
        <Composer
          experts={props.experts}
          expert={props.expert}
          onSelectExpert={props.onSelectExpert}
          draft={props.draft}
          onDraftChange={props.onDraftChange}
          isAnswering={false}
          disabled
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </>
    );
  }

  return <ExpertConversation {...props} initialMessages={fromStoredMessages(conversation.data)} />;
}
