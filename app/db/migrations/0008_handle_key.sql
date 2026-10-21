-- Usernames (decision 0009): the look-alike key. Dots and underscores are dropped, 0-9 read as
-- o i z e a s g t b g, l as i, then rn as m and vv as w, so "maria.santos", "mariasantos" and
-- "m4ria_santos" are one name. New names are
-- checked against it; existing accounts keep their names (npm run handles:check lists any that clash).
-- Same rule as handleKey() in app/modules/accounts/handles.ts; a test keeps the two in step.
ALTER TABLE users ADD COLUMN handle_key text GENERATED ALWAYS AS (replace(replace(translate(handle, '0123456789l._', 'oizeasgtbgi'), 'rn', 'm'), 'vv', 'w')) STORED;
CREATE INDEX users_handle_key ON users (handle_key);
