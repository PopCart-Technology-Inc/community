-- Usernames (decision 0009): the look-alike key. Dots and underscores are dropped and 0 1 3 4 5 7 read
-- as o i e a s t, so "maria.santos", "mariasantos" and "m4ria_santos" are one name. New names are
-- checked against it; existing accounts keep their names (npm run handles:check lists any that clash).
-- Same rule as handleKey() in app/modules/accounts/handles.ts; a test keeps the two in step.
ALTER TABLE users ADD COLUMN handle_key text GENERATED ALWAYS AS (translate(handle, '013457._', 'oieast')) STORED;
CREATE INDEX users_handle_key ON users (handle_key);
