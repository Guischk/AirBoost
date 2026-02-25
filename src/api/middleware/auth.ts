import { bearer } from "@elysiajs/bearer";
import { Elysia } from "elysia";
import { config } from "../../config";
import { loggers } from "../../lib/logger";

const log = loggers.auth;

if (config.authDisabled) {
	log.warn("Authentication is DISABLED (AUTH_DISABLED=true). All routes are publicly accessible.");
}

/**
 * Bearer Token Authentication Middleware
 * Securely compares the Authorization header with the configured token.
 * Anonymous access is only allowed when AUTH_DISABLED=true (development).
 */
export const bearerAuth = new Elysia({ name: "bearerAuth" })
	.use(bearer())
	.derive({ as: "global" }, async ({ bearer, set }) => {
		// Allow anonymous access only when explicitly disabled via AUTH_DISABLED=true
		if (config.authDisabled) {
			return { user: "anonymous" };
		}

		const bearerToken = config.bearerToken;

		if (!bearer) {
			set.status = 401;
			throw new Error("Unauthorized");
		}

		// Constant-time token comparison to prevent timing attacks.
		// Pad both inputs to the same length before timingSafeEqual so that
		// an attacker cannot learn the expected token length via response timing.
		const expectedBytes = new TextEncoder().encode(bearerToken);
		const providedBytes = new TextEncoder().encode(bearer);

		const maxLen = Math.max(expectedBytes.length, providedBytes.length);
		const paddedExpected = new Uint8Array(maxLen);
		const paddedProvided = new Uint8Array(maxLen);
		paddedExpected.set(expectedBytes);
		paddedProvided.set(providedBytes);

		const crypto = await import("node:crypto");
		const isValid = crypto.timingSafeEqual(
			new Uint8Array(paddedExpected),
			new Uint8Array(paddedProvided),
		);

		// Reject if original lengths differ OR comparison fails
		if (expectedBytes.length !== providedBytes.length || !isValid) {
			set.status = 401;
			throw new Error("Unauthorized");
		}

		return {
			user: "authenticated",
		};
	});
