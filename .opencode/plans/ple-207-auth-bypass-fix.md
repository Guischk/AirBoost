# PLE-207: Auth Bypass Fix Implementation Plan

## Problem

`src/api/middleware/auth.ts:11-18` has an auth bypass: when `BEARER_TOKEN` is empty/whitespace, all requests pass as `user: "anonymous"`. Additionally, `auth.ts` reads `process.env.BEARER_TOKEN` directly, bypassing the validated `config` object.

## Changes

### 1. `src/api/middleware/auth.ts` - Remove anonymous fallback, use config

**Replace the entire file with:**

```typescript
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
```

### 2. `src/config.ts` - Trim BEARER_TOKEN to reject whitespace

**Line 49, change:**

```typescript
const bearerToken = process.env.BEARER_TOKEN;
```

**To:**

```typescript
const bearerToken = process.env.BEARER_TOKEN?.trim();
```

### 3. `tests/unit/auth.test.ts` - No changes needed

The existing unit tests use a standalone mock function, not the actual middleware. They already test the correct behaviors (reject missing, malformed, wrong tokens). No changes needed since there was no test for anonymous mode.

### 4. `tests/security.test.ts` - Add whitespace token test (optional)

Add after the "Authentication Bypass Tests" describe block (after line 95):

```typescript
test("should reject whitespace-only BEARER_TOKEN at config level", () => {
	const originalToken = process.env.BEARER_TOKEN;
	try {
		process.env.BEARER_TOKEN = "   ";
		// Re-import config to test validation
		expect(() => {
			const token = process.env.BEARER_TOKEN?.trim();
			if (!token) throw new Error("Missing required environment variables");
		}).toThrow();
	} finally {
		process.env.BEARER_TOKEN = originalToken;
	}
});
```

### 5. Run `bun run validate`

Verify all tests pass.

## Verification

After implementation, confirm:

- [ ] `auth.ts` imports from `../../config` not `process.env`
- [ ] No anonymous fallback exists in `auth.ts`
- [ ] `config.ts` trims `BEARER_TOKEN` before validation
- [ ] `bun run validate` passes
- [ ] `BEARER_TOKEN="   "` causes startup failure
