import { useEffect, useRef } from "react";
import { Composer } from "./composer";
import { ExpertIntro } from "./expert-intro";
import { MessageList } from "./message-list";
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

/**
 * The conversation with one expert. The parent gives it `key={expert.id}`, so choosing another
 * expert unmounts it: the answer in progress is aborted and the conversation of the page starts
 * over. The typed draft lives in the parent and survives the switch.
 */
export function ExpertChat({
  experts,
  expert,
  onSelectExpert,
  draft,
  onDraftChange,
}: ExpertChatProps) {
  const chat = useExpertChat(expert.id);
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
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 pt-6 pb-20">
        {chat.messages.length === 0 ? (
          <ExpertIntro expert={expert} onAsk={ask} disabled={chat.isAnswering} />
        ) : null}
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
