CREATE TABLE `embedding` (
	`node_id` text NOT NULL,
	`project_id` text NOT NULL,
	`vector` blob NOT NULL,
	`dimension` integer NOT NULL,
	`content_hash` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `project_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `query_embedding_cache` (
	`query_hash` text PRIMARY KEY NOT NULL,
	`query_text` text NOT NULL,
	`vector` blob NOT NULL,
	`dimension` integer NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `embedding_project_idx` ON `embedding` (`project_id`);--> statement-breakpoint
CREATE INDEX `embedding_hash_idx` ON `embedding` (`project_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `query_cache_model_idx` ON `query_embedding_cache` (`model`);
