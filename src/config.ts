/**
 * Configuration file for Airboost
 * Simple configuration with environment variables
 */

export type SyncMode = "polling" | "webhook" | "manual";

export interface Config {
	// Server settings
	port: number;

	// Airtable settings
	airtableToken: string;
	airtableBaseId: string;

	// API settings
	bearerToken: string;

	// Sync mode settings
	syncMode: SyncMode;

	// Cache settings (polling mode)
	refreshInterval: number;

	// Failsafe refresh (webhook mode)
	failsafeRefreshInterval: number;

	// Storage settings
	storagePath: string;
	enableAttachmentDownload: boolean;

	// Webhook settings (webhook mode)
	// Note: Le secret HMAC est stocké en SQLite (macSecretBase64 retourné par Airtable)
	webhookRateLimit: number;
	webhookTimestampWindow: number;
	webhookIdempotencyTTL: number;
	webhookAutoSetup: boolean;
	webhookPublicUrl: string;

	// Logger settings
	logLevel: number;
	logFancy: boolean;
}

export function loadConfig(): Config {
	// Required environment variables
	const airtableToken = process.env.AIRTABLE_PERSONAL_TOKEN;
	const airtableBaseId = process.env.AIRTABLE_BASE_ID;
	const bearerToken = process.env.BEARER_TOKEN?.trim();

	if (!airtableToken || !airtableBaseId || !bearerToken) {
		throw new Error(
			"Missing required environment variables. Please set:\n" +
				"- AIRTABLE_PERSONAL_TOKEN\n" +
				"- AIRTABLE_BASE_ID\n" +
				"- BEARER_TOKEN",
		);
	}

	// Parse sync mode
	const syncModeEnv = process.env.SYNC_MODE?.toLowerCase() || "polling";
	if (!["polling", "webhook", "manual"].includes(syncModeEnv)) {
		throw new Error(`Invalid SYNC_MODE: ${syncModeEnv}. Must be one of: polling, webhook, manual`);
	}
	const syncMode = syncModeEnv as SyncMode;

	// Validate webhook mode requirements
	const webhookPublicUrl = process.env.WEBHOOK_PUBLIC_URL || "";
	if (syncMode === "webhook" && !webhookPublicUrl) {
		throw new Error(
			"WEBHOOK_PUBLIC_URL is required when SYNC_MODE=webhook.\n" +
				"Example: WEBHOOK_PUBLIC_URL=https://airboost.yourcompany.com",
		);
	}

	return {
		port: Number.parseInt(process.env.PORT || "3000"),
		airtableToken,
		airtableBaseId,
		bearerToken,

		// Sync mode
		syncMode,

		// Polling mode: refresh interval
		refreshInterval: Number.parseInt(process.env.REFRESH_INTERVAL || "86400"), // 24 hours default

		// Webhook mode: failsafe refresh interval
		failsafeRefreshInterval: Number.parseInt(process.env.FAILSAFE_REFRESH_INTERVAL || "86400"), // 24 hours default

		storagePath: process.env.STORAGE_PATH || "./data/attachments",
		enableAttachmentDownload: process.env.ENABLE_ATTACHMENT_DOWNLOAD !== "false", // Default to true

		// Webhook settings
		// Note: Le secret HMAC est stocké en SQLite (macSecretBase64 retourné par Airtable)
		webhookRateLimit: Number.parseInt(process.env.WEBHOOK_RATE_LIMIT || "30"), // seconds
		webhookTimestampWindow: Number.parseInt(process.env.WEBHOOK_TIMESTAMP_WINDOW || "300"), // 5 minutes
		webhookIdempotencyTTL: Number.parseInt(process.env.WEBHOOK_IDEMPOTENCY_TTL || "86400"), // 24 hours
		webhookAutoSetup: process.env.WEBHOOK_AUTO_SETUP !== "false", // Default to true
		webhookPublicUrl,

		// Logger settings
		logLevel: Number.parseInt(process.env.CONSOLA_LEVEL || "3"), // 3 = info level
		logFancy: process.env.CONSOLA_FANCY !== "false", // Default to true
	};
}

// Export the config for use in other files
export const config = loadConfig();
