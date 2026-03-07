CREATE TABLE `agent_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content` text NOT NULL,
	`type` text NOT NULL,
	`tags` text NOT NULL DEFAULT '[]',
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_accessed` integer NOT NULL,
	`access_count` integer NOT NULL DEFAULT 0,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `agent_memory_project_idx` ON `agent_memory` (`project_id`);--> statement-breakpoint
CREATE INDEX `agent_memory_type_idx` ON `agent_memory` (`project_id`,`type`);--> statement-breakpoint
CREATE INDEX `agent_memory_accessed_idx` ON `agent_memory` (`project_id`,`time_accessed`);
