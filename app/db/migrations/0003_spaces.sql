-- Spaces and messages: what the Requests flow and DM unread counts need, nothing more.
-- started_by: who opened the conversation, so the other person sees it under Requests until they accept.
-- a_read_at / b_read_at: when user_a / user_b last read it (messages after that, from the other person, are unread).
ALTER TABLE conversations ADD COLUMN started_by uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN a_read_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE conversations ADD COLUMN b_read_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX conversations_user_b ON conversations (user_b);
