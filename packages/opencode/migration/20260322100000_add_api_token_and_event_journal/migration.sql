-- API tokens for bearer auth (cross-device access)
CREATE TABLE IF NOT EXISTS `api_token` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `name` TEXT NOT NULL,
  `token_hash` TEXT NOT NULL UNIQUE,
  `token_prefix` TEXT NOT NULL,
  `scopes` TEXT NOT NULL DEFAULT '["*"]',
  `expires_at` INTEGER,
  `last_used_at` INTEGER,
  `time_created` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `time_updated` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS `api_token_hash_idx` ON `api_token` (`token_hash`);

-- Event journal for SSE replay / catch-up after disconnect
CREATE TABLE IF NOT EXISTS `event_journal` (
  `seq` INTEGER PRIMARY KEY AUTOINCREMENT,
  `type` TEXT NOT NULL,
  `payload` TEXT NOT NULL,
  `time_created` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS `event_journal_type_idx` ON `event_journal` (`type`);
CREATE INDEX IF NOT EXISTS `event_journal_time_idx` ON `event_journal` (`time_created`);
