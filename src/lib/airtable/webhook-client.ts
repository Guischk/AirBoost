/**
 * Airtable Webhook Management Client
 * Handles webhook creation, listing, and deletion via Airtable API
 */

import { config } from "../../config";
import { loggers } from "../logger";

const logger = loggers.webhook;

interface AirtableWebhook {
	id: string;
	macSecretBase64: string;
	areNotificationsEnabled: boolean;
	cursorForNextPayload: number;
	isHookEnabled: boolean;
	lastSuccessfulNotificationTime: string | null;
	notificationUrl: string;
	expirationTime: string;
	specification: {
		options: {
			filters: {
				dataTypes: string[];
			};
			includes?: {
				includeCellValuesInFieldIds?: string;
				includePreviousCellValues?: boolean;
				includePreviousFieldDefinitions?: boolean;
			};
		};
	};
}

interface ListWebhooksResponse {
	webhooks: AirtableWebhook[];
}

interface CreateWebhookResponse {
	id: string;
	macSecretBase64: string;
	expirationTime: string;
}

export class AirtableWebhookClient {
	private baseId: string;
	private token: string;
	private apiUrl = "https://api.airtable.com/v0";

	constructor() {
		if (!config.airtableBaseId) {
			throw new Error("AIRTABLE_BASE_ID not configured");
		}
		if (!config.airtableToken) {
			throw new Error("AIRTABLE_PERSONAL_TOKEN not configured");
		}

		this.baseId = config.airtableBaseId;
		this.token = config.airtableToken;
	}

	/**
	 * List all webhooks for the base
	 */
	async listWebhooks(): Promise<AirtableWebhook[]> {
		const url = `${this.apiUrl}/bases/${this.baseId}/webhooks`;

		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to list webhooks: ${response.status} - ${error}`);
		}

		const data = (await response.json()) as ListWebhooksResponse;
		return data.webhooks;
	}

	/**
	 * Create a new webhook pointing to Airboost
	 */
	async createWebhook(notificationUrl: string): Promise<CreateWebhookResponse> {
		const url = `${this.apiUrl}/bases/${this.baseId}/webhooks`;

		const body = {
			notificationUrl,
			specification: {
				options: {
					filters: {
						dataTypes: ["tableData", "tableFields", "tableMetadata"],
					},
					includes: {
						includeCellValuesInFieldIds: "all",
						includePreviousCellValues: false,
						includePreviousFieldDefinitions: false,
					},
				},
			},
		};

		logger.start("Creating Airtable webhook");
		logger.info("Webhook configuration", {
			url: notificationUrl,
		});

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to create webhook: ${response.status} - ${error}`);
		}

		const data = (await response.json()) as CreateWebhookResponse;

		// Store the macSecretBase64 returned by Airtable
		const { sqliteService } = await import("../sqlite");

		// Ensure database is connected
		if (!sqliteService.isConnected()) {
			await sqliteService.connect();
		}

		await sqliteService.storeWebhookConfig(data.id, data.macSecretBase64, notificationUrl);

		logger.success("Webhook created successfully", {
			id: data.id,
			expires: data.expirationTime,
			secretPreview: `${data.macSecretBase64.substring(0, 10)}...`,
		});

		return data;
	}

	/**
	 * Delete a webhook by ID
	 */
	async deleteWebhook(webhookId: string): Promise<void> {
		const url = `${this.apiUrl}/bases/${this.baseId}/webhooks/${webhookId}`;

		const response = await fetch(url, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to delete webhook: ${response.status} - ${error}`);
		}

		logger.success(`Webhook ${webhookId} deleted`);
	}

	/**
	 * Check if a webhook already exists for the given URL
	 */
	async findWebhookByUrl(notificationUrl: string): Promise<AirtableWebhook | null> {
		const webhooks = await this.listWebhooks();
		return webhooks.find((wh) => wh.notificationUrl === notificationUrl) || null;
	}

	/**
	 * Enable notifications for a webhook
	 * Note: Airtable will ping the webhook URL to verify it's accessible before enabling
	 */
	async enableNotifications(webhookId: string, retries = 3, delayMs = 2000): Promise<void> {
		const url = `${this.apiUrl}/bases/${this.baseId}/webhooks/${webhookId}/enableNotifications`;

		for (let attempt = 1; attempt <= retries; attempt++) {
			try {
				logger.info(
					`Enabling notifications for webhook ${webhookId} (attempt ${attempt}/${retries})`,
				);

				const response = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ enable: true }),
				});

				if (!response.ok) {
					const error = await response.text();

					// If 422, Airtable couldn't verify the webhook endpoint
					if (response.status === 422) {
						logger.warn(`Webhook endpoint verification failed (attempt ${attempt}/${retries})`);
						logger.warn("This usually means Airtable couldn't reach or verify the webhook URL");
						logger.warn("Error details", error);

						// Retry with exponential backoff if not last attempt
						if (attempt < retries) {
							const waitTime = delayMs * attempt;
							logger.info(`Retrying in ${waitTime}ms`);
							await new Promise((resolve) => setTimeout(resolve, waitTime));
							continue;
						}
					}

					throw new Error(`Failed to enable notifications: ${response.status} - ${error}`);
				}

				logger.success(`Notifications enabled for webhook ${webhookId}`);
				return;
			} catch (error) {
				if (attempt === retries) {
					throw error;
				}
				const waitTime = delayMs * attempt;
				logger.warn(`Error enabling notifications (attempt ${attempt}/${retries})`, error);
				logger.info(`Retrying in ${waitTime}ms`);
				await new Promise((resolve) => setTimeout(resolve, waitTime));
			}
		}
	}

	/**
	 * Verify that a webhook endpoint is reachable
	 * This helps diagnose issues before Airtable attempts to enable notifications
	 */
	private async verifyWebhookEndpoint(url: string): Promise<boolean> {
		try {
			logger.debug(`Verifying webhook endpoint is accessible: ${url}`);

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "Airboost-Webhook-Verify/1.0",
				},
				body: JSON.stringify({ test: true }),
				signal: AbortSignal.timeout(5000), // 5 second timeout
			});

			// We expect 401/403 (missing auth) or 400 (invalid payload) - these are OK
			// We just want to know the endpoint exists and responds
			const isAccessible =
				response.status === 400 ||
				response.status === 401 ||
				response.status === 403 ||
				response.status === 200;

			if (isAccessible) {
				logger.success(`Webhook endpoint is accessible (status: ${response.status})`);
			} else {
				logger.warn(`Webhook endpoint returned unexpected status: ${response.status}`);
			}

			return isAccessible;
		} catch (error) {
			logger.error("Failed to verify webhook endpoint", error);
			return false;
		}
	}

	/**
	 * Setup webhook with auto-configuration
	 * - Checks if webhook exists
	 * - Creates if missing
	 * - Verifies endpoint is accessible
	 * - Enables notifications with retry
	 */
	async setupWebhook(notificationUrl: string): Promise<{
		webhookId: string;
		created: boolean;
	}> {
		logger.info("Checking for existing webhooks");

		// Check if webhook already exists
		const existing = await this.findWebhookByUrl(notificationUrl);

		if (existing) {
			logger.success(`Webhook already exists: ${existing.id}`, {
				url: existing.notificationUrl,
				enabled: existing.isHookEnabled,
				notifications: existing.areNotificationsEnabled,
			});

			// Enable notifications if disabled
			if (!existing.areNotificationsEnabled) {
				// Verify endpoint before attempting to enable
				const isAccessible = await this.verifyWebhookEndpoint(notificationUrl);
				if (!isAccessible) {
					logger.warn(
						"Webhook endpoint may not be accessible - attempting to enable notifications anyway",
					);
				}

				await this.enableNotifications(existing.id);
			}

			return {
				webhookId: existing.id,
				created: false,
			};
		}

		// Create new webhook
		const result = await this.createWebhook(notificationUrl);

		// Verify endpoint is accessible before enabling notifications
		const isAccessible = await this.verifyWebhookEndpoint(notificationUrl);
		if (!isAccessible) {
			logger.warn(
				"Warning: Webhook endpoint verification failed. This may cause enableNotifications to fail.",
			);
			logger.warn("Airtable needs to be able to reach this URL to enable notifications.");
		}

		// Add a small delay to ensure the server is fully ready
		logger.info("Waiting 2s for server to be fully ready");
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Enable notifications for new webhook with retry logic
		await this.enableNotifications(result.id);

		return {
			webhookId: result.id,
			created: true,
		};
	}
}
