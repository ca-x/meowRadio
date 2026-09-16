ALTER TABLE users ADD COLUMN nickname TEXT CHECK(nickname IS NULL OR length(nickname) <= 60);
ALTER TABLE users ADD COLUMN avatar_revision TEXT;
