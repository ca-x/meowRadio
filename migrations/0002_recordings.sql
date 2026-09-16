CREATE TABLE recordings (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
    station_id TEXT NOT NULL,
    station_name TEXT NOT NULL CHECK(length(station_name) BETWEEN 1 AND 250),
    mime_type TEXT NOT NULL CHECK(mime_type IN ('audio/webm', 'audio/ogg', 'audio/mp4')),
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    duration_seconds REAL NOT NULL CHECK(duration_seconds BETWEEN 0 AND 3600),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX recordings_user_created ON recordings(user_id, created_at DESC);
