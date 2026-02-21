import { bearer } from "@elysiajs/bearer";
import { Elysia } from "elysia";
import { config } from "../../config";

/**
 * Bearer Token Authentication Middleware
 * Securely compares the Authorization header with the configured token
 * Note: config.bearerToken is guaranteed non-empty by loadConfig() validation
 */
export const bearerAuth = new Elysia({ name: "bearerAuth" })
	.use(bearer())
	.derive({ as: "global" }, async ({ bearer, set }) => {
		const bearerToken = config.bearerToken;

		if (!bearer) {
			set.status = 401;
			throw new Error("Unauthorized");
		}

		// Use Bun's native timingSafeEqual (or create a Buffer comparison if needed)
		const expectedBuffer = Buffer.from(bearerToken);
		const providedBuffer = Buffer.from(bearer);

		if (expectedBuffer.length !== providedBuffer.length) {
			set.status = 401;
			throw new Error("Unauthorized");
		}

		// Timing safe comparison to prevent timing attacks
		// Using Bun.crypto if available or node:crypto
		const crypto = await import("node:crypto");
		const isValid = crypto.timingSafeEqual(
			new Uint8Array(expectedBuffer),
			new Uint8Array(providedBuffer),
		);

		if (!isValid) {
			set.status = 401;
			throw new Error("Unauthorized");
		}

		return {
			user: "authenticated",
		};
	});
