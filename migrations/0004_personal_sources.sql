CREATE TABLE personal_sources (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 250),
    kind TEXT NOT NULL CHECK(kind IN ('url','file')),
    url TEXT,
    is_subscription INTEGER NOT NULL DEFAULT 0 CHECK(is_subscription IN (0,1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(id,user_id)
);
CREATE INDEX personal_sources_user ON personal_sources(user_id);
CREATE TABLE personal_stations (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    candidates_json TEXT NOT NULL,
    position INTEGER NOT NULL,
    FOREIGN KEY(source_id,user_id) REFERENCES personal_sources(id,user_id) ON DELETE CASCADE,
    UNIQUE(source_id,name)
);
CREATE INDEX personal_stations_user_source ON personal_stations(user_id,source_id,position);
ALTER TABLE favorites ADD COLUMN personal_station_id TEXT REFERENCES personal_stations(id) ON DELETE CASCADE;
CREATE INDEX favorites_personal_station ON favorites(personal_station_id);
