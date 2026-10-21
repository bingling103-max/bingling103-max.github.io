-- Ling's Classroom · one row per student device
CREATE TABLE IF NOT EXISTS progress (
  id         TEXT PRIMARY KEY,   -- anonymous device id generated in the browser
  class_code TEXT,
  student    TEXT,
  updated_at INTEGER,
  data       TEXT NOT NULL       -- full JSON doc: {class_code, student, avatar, updated_at, forms:{...}}
);
CREATE INDEX IF NOT EXISTS idx_progress_class   ON progress(class_code);
CREATE INDEX IF NOT EXISTS idx_progress_updated ON progress(updated_at);

-- v2 · live class (the Worker also creates these by itself on first use)
CREATE TABLE IF NOT EXISTS class_state (class_code TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER);
