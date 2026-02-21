import { Elysia } from "elysia";
import { timingSafeEqual } from "node:crypto";
import { calculateWebhookHmac } from "../../lib/airtable/webhook-hmac";
import { config } from "../../config";
import { loggers } from "../../lib/logger";

const log = loggers.webhook;

/** In-memory rate limiting: timestamp of last successfully processed webhook */
let lastProcessedTime = 0;

/**
 * Detect Airtable ping payloads.
 * Pings are empty bodies ({}) or { ping: true } - they contain none of the
 * standard notification fields (base, webhook, timestamp).
 */
function isPing(body: Record<string, unknown>): boolean {
	return !("base" in body || "webhook" in body || "timestamp" in body);
}

export const webhooks = new Elysia({ prefix: "/webhooks" }).post(
	"/airtable/refresh",
	async ({ request, set, store }) => {
		// NOTE: Bun/Elysia type definitions conflict with Web Standard Request API.
		// At runtime, request is a standard Request object with text() and headers.get().
		// This is a known project-wide issue (see app.ts:73 using request.method).

		// 1. Read raw body (needed for HMAC validation against exact bytes)
		const rawBody = await (request as any).text();

		// 2. Parse JSON manually (we skipped Elysia's parser via parse: "none")
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(rawBody);
		} catch {
			log.warn("Webhook rejected: malformed JSON payload");
			set.status = 400;
			return { error: "Invalid JSON payload", backend: "sqlite" };
		}

		// 3. Ping detection - Airtable sends empty payloads to verify endpoint liveness
		if (isPing(body)) {
			log.info("Received Airtable ping");
			return { status: "success" };
		}

		// --- From here on, all payloads require full security validation ---

		// 4. HMAC Signature validation
		const signatureHeader = (request.headers as any).get("x-airtable-content-mac") as string | null;
		if (!signatureHeader) {
			log.warn("Webhook rejected: missing signature header");
			set.status = 401;
			return { error: "Missing signature header", backend: "sqlite" };
		}

		const { sqliteService } = await import("../../lib/sqlite");
		const webhookConfig = await sqliteService.getWebhookConfig();

		if (!webhookConfig) {
			log.error("Webhook rejected: no webhook configuration found in database");
			set.status = 500;
			return { error: "Webhook not configured", backend: "sqlite" };
		}

		const expectedHash = calculateWebhookHmac(webhookConfig.macSecretBase64, rawBody);
		const expectedSignature = `hmac-sha256=${expectedHash}`;

		// Timing-safe comparison to prevent timing attacks
		const expectedBuf = Buffer.from(expectedSignature);
		const providedBuf = Buffer.from(signatureHeader);

		if (
			expectedBuf.length !== providedBuf.length ||
			!timingSafeEqual(new Uint8Array(expectedBuf), new Uint8Array(providedBuf))
		) {
			log.warn("Webhook rejected: invalid HMAC signature");
			set.status = 401;
			return { error: "Invalid signature", backend: "sqlite" };
		}

		// 5. Timestamp validation - reject payloads older than webhookTimestampWindow
		const timestamp = body.timestamp as string | undefined;
		if (timestamp) {
			const webhookTime = new Date(timestamp).getTime();
			const now = Date.now();
			const windowMs = config.webhookTimestampWindow * 1000;

			if (Number.isNaN(webhookTime) || Math.abs(now - webhookTime) > windowMs) {
				log.warn(`Webhook rejected: expired timestamp (${timestamp})`);
				set.status = 401;
				return { error: "Expired timestamp", backend: "sqlite" };
			}
		}

		// 6. Rate limiting - prevent webhook spam / DoS
		const now = Date.now();
		const rateLimitMs = config.webhookRateLimit * 1000;
		const timeSinceLastProcess = now - lastProcessedTime;

		if (lastProcessedTime > 0 && timeSinceLastProcess < rateLimitMs) {
			const retryAfter = Math.ceil((rateLimitMs - timeSinceLastProcess) / 1000);
			log.warn(`Webhook rate limited: retry after ${retryAfter}s`);
			set.status = 429;
			return { error: "Rate limit exceeded", retryAfter };
		}

		// 7. Idempotency check - skip already-processed webhooks
		const webhookId = (body.webhook as Record<string, unknown>)?.id as string;
		const idempotencyKey = `${webhookId}:${timestamp}`;

		const alreadyProcessed = await sqliteService.isWebhookProcessed(idempotencyKey);
		if (alreadyProcessed) {
			log.info(`Webhook skipped: already processed (${idempotencyKey})`);
			return { status: "skipped", reason: "Already processed" };
		}

		// 8. Forward to worker for processing
		const worker = (store as { worker?: Worker }).worker;

		if (!worker) {
			log.error("Worker not available to handle webhook");
			set.status = 503;
			return { error: "Worker service unavailable", backend: "sqlite" };
		}

		// Update rate limit tracker
		lastProcessedTime = Date.now();

		// Mark as processed for idempotency
		await sqliteService.markWebhookProcessed(idempotencyKey, "incremental", {
			timestamp,
			webhookId,
		});

		// Forward payload to worker
		worker.postMessage({
			type: "WEBHOOK_RECEIVED",
			payload: body,
		});

		log.info(`Webhook processed successfully (${idempotencyKey})`);

		return {
			status: "success",
		};
	},
	{
		parse: "none", // Skip Elysia body parsing - we need raw body for HMAC
		detail: {
			summary: "Airtable Webhook Receiver",
			description:
				"Receives and processes webhook notifications from Airtable with HMAC signature validation, timestamp check, rate limiting, and idempotency",
		},
	},
);
