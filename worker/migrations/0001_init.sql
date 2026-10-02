-- Contributed test runs. The gzipped CSV lives in the row (well under D1's 2 MB row limit).
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  install_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  app_version TEXT,
  mode TEXT,              -- 'single' | 'loop'
  source TEXT,            -- 'native' | 'generic-sensor' | 'devicemotion'
  sample_rate REAL,
  device TEXT,
  user_agent TEXT,
  result_x REAL, result_y REAL, result_z REAL,   -- mm, the app's answer
  quality TEXT,
  warnings TEXT,          -- JSON array
  ref_x REAL, ref_y REAL, ref_z REAL,            -- mm, user's measurement (optional)
  ref_method TEXT,        -- 'tape' | 'laser' | 'estimate'
  route TEXT,
  notes TEXT,
  flagged_error INTEGER NOT NULL DEFAULT 0,      -- user says the run went wrong
  meta TEXT,              -- full submitted metadata, JSON
  csv_bytes INTEGER NOT NULL,
  csv_gz BLOB NOT NULL
);
CREATE INDEX runs_created ON runs (created_at);
CREATE INDEX runs_install ON runs (install_id, created_at);
CREATE INDEX runs_ip ON runs (ip_hash, created_at);
