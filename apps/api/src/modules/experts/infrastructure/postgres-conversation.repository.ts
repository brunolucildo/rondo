import { sqlStateOf } from "../../../common/sql-state";
import type { DatabaseClient } from "../../../observability/db-telemetry";
import { encodeCursor } from "../domain/conversation-cursor";
import type {
  ConversationRepository,
  MessagePage,
  NewMessage,
  PageRequest,
  StoredMessage,
} from "../domain/conversation-ports";
import { ConversationStorageError } from "../domain/expert-errors";
import { EXPERT_LIMITS } from "../domain/expert-rules";
import type { ExpertId } from "../domain/expert";
import { parseStoredCitations } from "../domain/grounding";

type Row = Record<string, unknown>;

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value) : null;
};

function toMessage(row: Row): StoredMessage | null {
  const createdAt = toDate(row.created_at);
  const citations = parseStoredCitations(row.citations ?? null);

  if (
    citations === undefined ||
    typeof row.id !== "string" ||
    (row.role !== "user" && row.role !== "assistant") ||
    typeof row.content !== "string" ||
    (row.status !== "complete" && row.status !== "incomplete") ||
    createdAt === null
  ) {
    return null;
  }

  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    citations,
    createdAt,
  };
}

/**
 * `ConversationRepository` over Postgres (ADR 0015, `pg` through the instrumented client). Every
 * statement filters by the user id of the session and binds every value as a parameter: the
 * expert id, the cursor and the content are never part of the SQL text. Errors are rethrown as
 * `ConversationStorageError` with the operation name only (a Postgres message can echo values).
 * Appending is the SQL function `expert_append_message`: the retention limit is applied in the
 * same transaction as the write.
 */
export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly database: DatabaseClient) {}

  async listPage(userId: string, expertId: ExpertId, request: PageRequest): Promise<MessagePage> {
    let rows: Row[];

    try {
      // One extra row tells whether there is an older page. The cursor is the (created_at, id)
      // of a message of this very conversation: an id from another conversation matches nothing.
      const result = await this.database.query<Row>(
        { operation: "select", collection: "expert_messages" },
        `select m.id, m.role, m.content, m.status, m.citations, m.created_at
           from public.expert_messages m
           join public.expert_conversations c on c.id = m.conversation_id
          where c.user_id = $1
            and c.expert_id = $2
            and ($3::uuid is null
                 or (m.created_at, m.id) < (select b.created_at, b.id
                                              from public.expert_messages b
                                             where b.id = $3::uuid and b.conversation_id = c.id))
          order by m.created_at desc, m.id desc
          limit $4`,
        [userId, expertId, request.before, request.limit + 1],
      );

      rows = result.rows;
    } catch (error) {
      throw new ConversationStorageError(`list_messages (${sqlStateOf(error) ?? "no_code"})`);
    }

    const newestFirst = rows.slice(0, request.limit).map(toMessage);

    if (newestFirst.some((message) => message === null)) {
      throw new ConversationStorageError("list_messages (UNEXPECTED_RESULT)");
    }

    const messages = (newestFirst as StoredMessage[]).reverse();
    const oldest = messages[0];

    return {
      messages,
      nextCursor:
        rows.length > request.limit && oldest !== undefined ? encodeCursor(oldest.id) : null,
    };
  }

  async append(
    userId: string,
    expertId: ExpertId,
    message: NewMessage,
  ): Promise<{ id: string; createdAt: Date }> {
    let rows: Row[];

    try {
      const result = await this.database.query<Row>(
        { operation: "rpc", procedure: "expert_append_message" },
        "select message_id, message_created_at from public.expert_append_message($1, $2, $3, $4, $5, $6, $7::jsonb)",
        [
          userId,
          expertId,
          message.role,
          message.content,
          message.status,
          EXPERT_LIMITS.conversationMessagesMax,
          message.citations === undefined || message.citations === null
            ? null
            : JSON.stringify(message.citations),
        ],
      );

      rows = result.rows;
    } catch (error) {
      throw new ConversationStorageError(`append_message (${sqlStateOf(error) ?? "no_code"})`);
    }

    const row = rows[0];
    const createdAt = toDate(row?.message_created_at);

    if (
      rows.length !== 1 ||
      row === undefined ||
      typeof row.message_id !== "string" ||
      createdAt === null
    ) {
      throw new ConversationStorageError("append_message (UNEXPECTED_RESULT)");
    }

    return { id: row.message_id, createdAt };
  }

  async remove(userId: string, messageId: string): Promise<void> {
    try {
      await this.database.query(
        { operation: "delete", collection: "expert_messages" },
        `delete from public.expert_messages m
          using public.expert_conversations c
          where m.id = $1::uuid and m.conversation_id = c.id and c.user_id = $2`,
        [messageId, userId],
      );
    } catch (error) {
      throw new ConversationStorageError(`remove_message (${sqlStateOf(error) ?? "no_code"})`);
    }
  }

  async clear(userId: string, expertId: ExpertId): Promise<void> {
    try {
      // The messages go with the conversation (`on delete cascade`).
      await this.database.query(
        { operation: "delete", collection: "expert_conversations" },
        "delete from public.expert_conversations where user_id = $1 and expert_id = $2",
        [userId, expertId],
      );
    } catch (error) {
      throw new ConversationStorageError(`clear_conversation (${sqlStateOf(error) ?? "no_code"})`);
    }
  }
}
