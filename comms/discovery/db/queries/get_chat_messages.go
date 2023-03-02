package queries

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"comms.audius.co/discovery/db"
)

// Get a chat message
const chatMessage = `
select message_id, chat_id, user_id, created_at, ciphertext from chat_message where chat_id = $1 and message_id = $2
`

type ChatMessageParams struct {
	ChatID    string `db:"chat_id" json:"chat_id"`
	MessageID string `db:"message_id" json:"message_id"`
}

func ChatMessage(q db.Queryable, ctx context.Context, arg ChatMessageParams) (db.ChatMessage, error) {
	var message db.ChatMessage
	err := q.GetContext(ctx, &message, chatMessage, arg.ChatID, arg.MessageID)
	return message, err
}

// Get chat messages and reactions
const chatMessagesAndReactions = `
SELECT chat_message.message_id, chat_message.chat_id, chat_message.user_id, chat_message.created_at, chat_message.ciphertext, COALESCE(jsonb_agg(reactions) FILTER (WHERE reactions.message_id IS NOT NULL), '[]') AS reactions
FROM chat_message
JOIN chat_member ON chat_message.chat_id = chat_member.chat_id
LEFT JOIN chat_message_reactions reactions ON chat_message.message_id = reactions.message_id
WHERE chat_member.user_id = $1
	AND chat_message.chat_id = $2
	AND chat_message.created_at < $4 
	AND chat_message.created_at > $5 
	AND (chat_member.cleared_history_at IS NULL 
		OR chat_message.created_at > chat_member.cleared_history_at
	)
GROUP BY chat_message.message_id
ORDER BY chat_message.created_at DESC, chat_message.message_id
LIMIT $3
`

type ChatMessagesAndReactionsParams struct {
	UserID int32     `db:"user_id" json:"user_id"`
	ChatID string    `db:"chat_id" json:"chat_id"`
	Limit  int32     `json:"limit"`
	Before time.Time `json:"before"`
	After  time.Time `json:"after"`
}

type ChatMessageAndReactionsRow struct {
	MessageID  string    `db:"message_id" json:"message_id"`
	ChatID     string    `db:"chat_id" json:"chat_id"`
	UserID     int32     `db:"user_id" json:"user_id"`
	CreatedAt  time.Time `db:"created_at" json:"created_at"`
	Ciphertext string    `db:"ciphertext" json:"ciphertext"`
	Reactions  Reactions `json:"reactions"`
}

type JSONTime struct {
	time.Time
}

type ChatMessageReactionRow struct {
	UserID    int32    `db:"user_id" json:"user_id"`
	MessageID string   `db:"message_id" json:"message_id"`
	Reaction  string   `db:"reaction" json:"reaction"`
	CreatedAt JSONTime `db:"created_at" json:"created_at"`
	UpdatedAt JSONTime `db:"updated_at" json:"updated_at"`
}

type Reactions []ChatMessageReactionRow

func (reactions *Reactions) Scan(value interface{}) error {
	bytes, ok := value.([]byte)
	if !ok {
		return errors.New("type assertion to []byte failed")
	}

	return json.Unmarshal(bytes, reactions)
}

// Override JSONB timestamp unmarshaling since the postgres driver
// does not convert timestamp strings in JSON -> time.Time
func (t *JSONTime) UnmarshalJSON(b []byte) error {
	timeformat := "2006-01-02T15:04:05.999999"
	var timestamp string
	err := json.Unmarshal(b, &timestamp)
	if err != nil {
		return err
	}
	t.Time, err = time.Parse(timeformat, timestamp)
	if err != nil {
		return err
	}
	return nil
}

func ChatMessagesAndReactions(q db.Queryable, ctx context.Context, arg ChatMessagesAndReactionsParams) ([]ChatMessageAndReactionsRow, error) {
	var rows []ChatMessageAndReactionsRow
	err := q.SelectContext(ctx, &rows, chatMessagesAndReactions,
		arg.UserID,
		arg.ChatID,
		arg.Limit,
		arg.Before,
		arg.After,
	)
	return rows, err
}

const numChatMessagesSince = `
WITH counts_per_chat AS (
  SELECT COUNT(*)
	FROM chat_message
	WHERE user_id = $1 and created_at > $2
	GROUP BY chat_id
)
SELECT COALESCE(SUM(count), 0) AS total_count, COALESCE(MAX(count), 0) as max_count_per_chat FROM counts_per_chat;
`

type NumChatMessagesSinceParams struct {
	UserID int32     `db:"user_id" json:"user_id"`
	Cursor time.Time `json:"cursor"`
}

type NumChatMessagesSinceRow struct {
	TotalCount      int `db:"total_count" json:"total_count"`
	MaxCountPerChat int `db:"max_count_per_chat" json:"max_count_per_chat"`
}

func NumChatMessagesSince(q db.Queryable, ctx context.Context, arg NumChatMessagesSinceParams) (NumChatMessagesSinceRow, error) {
	var counts NumChatMessagesSinceRow
	err := q.GetContext(ctx, &counts, numChatMessagesSince, arg.UserID, arg.Cursor)
	return counts, err
}
