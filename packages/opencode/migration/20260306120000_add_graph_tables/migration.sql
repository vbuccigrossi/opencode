CREATE TABLE `graph_node` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`file_path` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`start_col` integer NOT NULL,
	`end_col` integer NOT NULL,
	`signature` text,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `graph_edge` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`kind` text NOT NULL,
	`file_path` text NOT NULL,
	`line` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `graph_node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `graph_node`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `graph_file_state` (
	`project_id` text NOT NULL,
	`file_path` text NOT NULL,
	`content_hash` text NOT NULL,
	`last_indexed` integer NOT NULL,
	`node_count` integer NOT NULL,
	PRIMARY KEY(`project_id`, `file_path`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `graph_node_project_idx` ON `graph_node` (`project_id`);--> statement-breakpoint
CREATE INDEX `graph_node_file_idx` ON `graph_node` (`project_id`,`file_path`);--> statement-breakpoint
CREATE INDEX `graph_node_name_idx` ON `graph_node` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `graph_node_kind_idx` ON `graph_node` (`project_id`,`kind`);--> statement-breakpoint
CREATE INDEX `graph_edge_project_idx` ON `graph_edge` (`project_id`);--> statement-breakpoint
CREATE INDEX `graph_edge_source_idx` ON `graph_edge` (`source_node_id`);--> statement-breakpoint
CREATE INDEX `graph_edge_target_idx` ON `graph_edge` (`target_node_id`);--> statement-breakpoint
CREATE INDEX `graph_edge_kind_idx` ON `graph_edge` (`project_id`,`kind`);