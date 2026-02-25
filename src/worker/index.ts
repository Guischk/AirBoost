/**
 * SQLite worker for data synchronization
 */

import { loggers } from "../lib/logger";
import { SQLiteBackend } from "./backends/sqlite-backend";

const logger = loggers.worker;

export interface WorkerMessage {
	type: "refresh:start" | "refresh:stop" | "stats:get" | "webhook:received";
	manual?: boolean;
	payload?: Record<string, unknown>;
}

export interface WorkerResponse {
	type: "refresh:done" | "refresh:error" | "stats:response";
	stats?: any;
	error?: string;
	manual?: boolean;
}

class SQLiteWorker {
	private backend: SQLiteBackend;
	private isRefreshing = false;

	constructor() {
		this.backend = new SQLiteBackend();
		logger.info("Initialized with SQLite backend");
	}

	async handleMessage(message: WorkerMessage): Promise<void> {
		logger.debug("Message received", message);

		switch (message.type) {
			case "refresh:start":
				await this.handleRefreshStart(message.manual);
				break;

			case "refresh:stop":
				await this.handleRefreshStop();
				break;

			case "stats:get":
				await this.handleStatsGet();
				break;

			case "webhook:received":
				await this.handleWebhookReceived(message.payload);
				break;

			default:
				logger.warn("Unknown message type", message);
		}
	}

	private async handleWebhookReceived(payload?: Record<string, unknown>): Promise<void> {
		if (!payload) {
			logger.warn("webhook:received with no payload, ignoring");
			return;
		}

		try {
			// Extract changedTablesById from the Airtable webhook payload
			// Airtable sends: { base, webhook, timestamp, changedTablesById, ... }
			const changedTablesById = payload.changedTablesById as
				| {
						[tableId: string]: {
							createdRecordsById?: { [recordId: string]: null };
							changedRecordsById?: { [recordId: string]: null };
							destroyedRecordIds?: string[];
						};
				  }
				| undefined;

			if (!changedTablesById || Object.keys(changedTablesById).length === 0) {
				logger.info("webhook:received — no changed tables, skipping incremental refresh");
				return;
			}

			logger.start("Starting incremental refresh from webhook");
			const stats = await this.backend.incrementalRefresh(changedTablesById);
			logger.success("Incremental refresh completed", stats);

			this.postMessage({
				type: "refresh:done",
				stats,
			});
		} catch (error) {
			logger.error("Error during incremental refresh", error);
			this.postMessage({
				type: "refresh:error",
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	private async handleRefreshStart(manual = false): Promise<void> {
		if (this.isRefreshing) {
			logger.info("Refresh already in progress, skipped");
			return;
		}

		this.isRefreshing = true;

		try {
			logger.start(`Starting ${manual ? "manual" : "automatic"} refresh`);

			const stats = await this.backend.refreshData();

			this.postMessage({
				type: "refresh:done",
				stats,
				manual,
			});
		} catch (error) {
			logger.error("Error during refresh", error);

			this.postMessage({
				type: "refresh:error",
				error: error instanceof Error ? error.message : "Unknown error",
				manual,
			});
		} finally {
			this.isRefreshing = false;
		}
	}

	private async handleRefreshStop(): Promise<void> {
		if (!this.isRefreshing) {
			logger.info("No refresh in progress");
			return;
		}

		logger.info("Refresh stop requested");
		// Note: In a more advanced implementation, we could
		// implement cancellation logic
		this.isRefreshing = false;
	}

	private async handleStatsGet(): Promise<void> {
		try {
			const stats = await this.backend.getStats();

			this.postMessage({
				type: "stats:response",
				stats,
			});
		} catch (error) {
			logger.error("Error retrieving stats", error);

			this.postMessage({
				type: "refresh:error",
				error: error instanceof Error ? error.message : "Stats retrieval failed",
			});
		}
	}

	private postMessage(response: WorkerResponse): void {
		if (typeof self !== "undefined" && self.postMessage) {
			// Web Worker context
			self.postMessage(response);
		} else {
			// Test or development context
			logger.debug("Response", response);
		}
	}

	async close(): Promise<void> {
		logger.info("Closing");

		if (this.isRefreshing) {
			logger.info("Waiting for refresh to complete");
			// In a more advanced implementation, we would wait for refresh completion
		}

		await this.backend.close();
		logger.success("Closed");
	}
}

// Worker execution context detection
let worker: SQLiteWorker;

// Worker initialization
function initializeWorker(): void {
	// Use SQLite as the only backend
	worker = new SQLiteWorker();
}

// Message handler for Web Worker
if (typeof self !== "undefined" && self.onmessage !== undefined) {
	// Web Worker context
	initializeWorker();

	self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
		if (worker) {
			await worker.handleMessage(event.data);
		}
	};

	self.onerror = (error) => {
		logger.error("Global worker error", error);
	};

	logger.ready("Ready to receive messages");
}

// Export for direct usage (tests, development)
export { SQLiteWorker };

// Auto-initialization if executed directly
if (import.meta.main) {
	logger.info("Direct execution for test");

	initializeWorker();

	// Basic test
	await worker.handleMessage({ type: "refresh:start", manual: true });

	logger.success("Test completed");
}
