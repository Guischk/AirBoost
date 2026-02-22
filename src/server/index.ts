/**
 * Main server entry point for Airboost
 * SQLite-only caching service configuration
 */

import { type SyncMode, config } from "../config";
import { loggers } from "../lib/logger";

const logger = loggers.server;

export interface ServerConfig {
	port: number;
	syncMode: SyncMode;
	refreshInterval: number;
	failsafeRefreshInterval: number;
}

export function getServerConfig(): ServerConfig {
	return {
		port: config.port,
		syncMode: config.syncMode,
		refreshInterval: config.refreshInterval,
		failsafeRefreshInterval: config.failsafeRefreshInterval,
	};
}

export async function startServer(overrideConfig?: Partial<ServerConfig>): Promise<void> {
	const fullConfig = { ...getServerConfig(), ...overrideConfig };

	logger.start("Starting Airboost service (SQLite)");
	logger.info("Configuration", {
		port: fullConfig.port,
		syncMode: fullConfig.syncMode,
		refreshInterval: fullConfig.syncMode === "polling" ? `${fullConfig.refreshInterval}s` : "N/A",
		failsafeRefreshInterval:
			fullConfig.syncMode === "webhook" ? `${fullConfig.failsafeRefreshInterval}s` : "N/A",
	});

	await startSQLiteServer(fullConfig);
}

async function startSQLiteServer(serverConfig: ServerConfig): Promise<void> {
	const { startSQLiteApiServer } = await import("../api/index");

	logger.start("Starting SQLite worker");

	const worker = new Worker("src/worker/index.ts");

	// Initialize SQLite service
	logger.info("Initializing SQLite databases");
	const { sqliteService } = await import("../lib/sqlite/index");
	await sqliteService.connect();
	logger.success("SQLite databases initialized");

	// Detect base change and reset if needed
	const { detectAndHandleBaseChange } = await import("../lib/base-change-detector");
	const baseChangeResult = await detectAndHandleBaseChange();
	if (baseChangeResult.changed) {
		if (baseChangeResult.isFirstInitialization) {
			logger.success("First initialization completed");
		} else {
			logger.success("Base change handled, data reset completed");
		}
	}

	// Sync table mappings on startup
	logger.start("Syncing table mappings");
	try {
		const { syncMappingsToDatabase } = await import("../lib/airtable/mapping-generator");
		await syncMappingsToDatabase();
		logger.success("Table mappings synced");
	} catch (error) {
		logger.warn("Failed to sync table mappings", error);
		logger.warn("Run 'bun run types' to generate mappings");
		// Continue startup - mappings are needed for webhooks but not for full refresh
	}

	worker.onmessage = (e) => {
		if (e.data?.type === "refresh:done") {
			logger.success("Refresh completed", e.data.stats);
		} else if (e.data?.type === "refresh:error") {
			logger.error("Refresh error", e.data.error);
		} else {
			logger.info("SQLite Worker message", e.data);
		}
	};

	worker.onerror = (error) => {
		logger.error("SQLite Worker error", error);
	};

	// Start the API server
	await startSQLiteApiServer(serverConfig.port, worker);

	// Handle sync mode specific logic
	switch (serverConfig.syncMode) {
		case "polling":
			await startPollingMode(worker, serverConfig);
			break;
		case "webhook":
			await startWebhookMode(worker, serverConfig);
			break;
		case "manual":
			await startManualMode();
			break;
	}

	logger.success("SQLite service fully started");
	logger.info("Storage", {
		databases: "data/airboost-v1.sqlite, data/airboost-v2.sqlite",
		attachments: process.env.STORAGE_PATH || "./data/attachments",
	});

	setupGracefulShutdown(worker);
}

/**
 * Polling mode: Regular full refresh at configured interval
 */
async function startPollingMode(worker: Worker, serverConfig: ServerConfig): Promise<void> {
	logger.info("Sync mode: POLLING");

	// Initial refresh on startup
	logger.start("Starting initial refresh");
	worker.postMessage({ type: "refresh:start" });

	// Periodic refresh
	setInterval(() => {
		logger.info("Periodic refresh triggered");
		worker.postMessage({ type: "refresh:start" });
	}, serverConfig.refreshInterval * 1000);

	const refreshMsg = formatDuration(serverConfig.refreshInterval);
	logger.ready(`Refresh scheduled every ${refreshMsg}`);
}

/**
 * Webhook mode: Real-time updates via Airtable webhooks + failsafe refresh
 */
async function startWebhookMode(worker: Worker, serverConfig: ServerConfig): Promise<void> {
	logger.info("Sync mode: WEBHOOK");

	// Initial refresh on startup (always, to ensure data consistency)
	logger.start("Starting initial refresh");
	worker.postMessage({ type: "refresh:start" });

	// Validate and sync webhooks before auto-setup
	// This ensures stored webhook config matches Airtable state
	try {
		const { validateAndSyncWebhooks } = await import("../lib/webhooks/validator");
		await validateAndSyncWebhooks();
	} catch (error) {
		logger.warn("Webhook validation error", error);
		// Continue startup even if validation fails
	}

	// Auto-setup webhooks if configured (will skip if already created by validator)
	try {
		const { autoSetupWebhooks } = await import("../lib/webhooks/auto-setup");
		await autoSetupWebhooks();
	} catch (error) {
		logger.warn("Webhook auto-setup error", error);
		// Continue startup even if webhook setup fails
	}

	// Failsafe refresh (safety net in case webhooks are missed)
	setInterval(() => {
		logger.info("Failsafe refresh triggered");
		worker.postMessage({ type: "refresh:start" });
	}, serverConfig.failsafeRefreshInterval * 1000);

	const failsafeMsg = formatDuration(serverConfig.failsafeRefreshInterval);
	logger.ready(`Failsafe refresh scheduled every ${failsafeMsg}`);
	logger.ready("Real-time updates via webhooks enabled");
}

/**
 * Manual mode: No automatic refresh, only via API
 */
async function startManualMode(): Promise<void> {
	logger.info("Sync mode: MANUAL");
	logger.ready("No automatic refresh - use POST /api/refresh to trigger");
}

/**
 * Format duration in human-readable format
 */
function formatDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = seconds % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours} hour${hours > 1 ? "s" : ""}`);
	if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? "s" : ""}`);
	if (remainingSeconds > 0 && hours === 0 && minutes === 0) {
		parts.push(`${remainingSeconds} seconds`);
	}

	return parts.join(" ") || `${seconds} seconds`;
}

function setupGracefulShutdown(worker: Worker): void {
	const shutdown = async (signal: string) => {
		logger.info(`Shutdown ${signal}`);

		try {
			worker.terminate();

			// Close SQLite service
			const { sqliteService } = await import("../lib/sqlite/index");
			await sqliteService.close();

			logger.success("Service stopped gracefully");
			process.exit(0);
		} catch (error) {
			logger.error("Error during shutdown", error);
			process.exit(1);
		}
	};

	process.on("SIGINT", () => shutdown("graceful"));
	process.on("SIGTERM", () => shutdown("requested"));
}
