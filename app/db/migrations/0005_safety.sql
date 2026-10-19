-- Safety additions (docs/api.md, "Safety and your data").
-- One report per person per target: a second report of the same thing is refused.
CREATE UNIQUE INDEX reports_once ON reports (reporter_id, target_kind, target_id);
CREATE INDEX reports_space ON reports (space_id, status, created_at);
-- A child_safety report hides the content at once; remember that the report did it, so a "keep"
-- decision can show it again without undoing a deletion by its author.
ALTER TABLE reports ADD COLUMN hid_content boolean NOT NULL DEFAULT false;

-- Appeals: the person's note, and who decided it (always a different staff member from the actor).
ALTER TABLE mod_actions ADD COLUMN appeal_note text NOT NULL DEFAULT '' CHECK (char_length(appeal_note) <= 1000);
ALTER TABLE mod_actions ADD COLUMN appeal_decided_by uuid REFERENCES users(id);
ALTER TABLE mod_actions ADD COLUMN appeal_decided_at timestamptz;
ALTER TABLE mod_actions ADD COLUMN appeal_decision_note text NOT NULL DEFAULT '';
ALTER TABLE mod_actions ADD CONSTRAINT mod_actions_appeal_decision CHECK (appeal_decision IS NULL OR appeal_decision IN ('upheld', 'overturned'));
CREATE INDEX mod_actions_appealed ON mod_actions (appealed_at) WHERE appealed_at IS NOT NULL AND appeal_decision IS NULL;
