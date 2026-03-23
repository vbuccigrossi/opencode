CREATE TABLE `scheduled_task` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `name` text NOT NULL,
  `cron` text NOT NULL,
  `prompt` text NOT NULL,
  `directory` text NOT NULL,
  `agent` text,
  `model` text,
  `delivery` text DEFAULT '{"type":"session"}',
  `enabled` integer NOT NULL DEFAULT 1,
  `last_run_at` integer,
  `last_status` text,
  `last_error` text,
  `last_session_id` text,
  `next_run_at` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `scheduled_task_project_idx` ON `scheduled_task` (`project_id`);
CREATE INDEX `scheduled_task_next_run_idx` ON `scheduled_task` (`enabled`, `next_run_at`);
