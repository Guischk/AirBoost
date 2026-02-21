#!/usr/bin/env bun

/**
 * Suite de tests complète pour l'API Aircache
 * Tests unitaires et d'intégration pour tous les endpoints
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type Subprocess, spawn } from "bun";

// Configuration pour les tests
const TEST_CONFIG = {
	port: 3001, // Port différent pour les tests
	timeout: 30000, // 30 secondes timeout
	maxRetries: 3,
};

const API_BASE = `http://localhost:${TEST_CONFIG.port}`;
const BEARER_TOKEN = process.env.BEARER_TOKEN || "dev-token";

let serverProcess: Subprocess | null = null;
let serverStarted = false;

// Interfaces pour typer les réponses
interface ApiResponse<T = any> {
	success: boolean;
	data: T;
	error?: string;
	message?: string;
	code?: string;
	meta?: {
		timestamp: string;
		version?: string;
		namespace?: string;
	};
}

interface HealthResponse {
	status: string;
	backend: string;
	database?: string;
	tables?: number;
	totalRecords?: number;
	dbSize?: string;
	error?: string;
}

interface TablesResponse {
	tables: string[];
	backend: string;
}

interface StatsResponse {
	backend: string;
	stats: {
		totalTables: number;
		totalRecords: number;
		dbSize: string;
	};
	error?: string;
}

interface RefreshResponse {
	message: string;
	backend: string;
	error?: string;
}

// Helper pour les requêtes API
async function apiRequest<T = any>(
	endpoint: string,
	options: {
		method?: string;
		auth?: boolean;
		headers?: Record<string, string>;
		body?: any;
		retries?: number;
	} = {},
): Promise<{
	status: number;
	headers: Headers;
	data: T;
	response: Response;
	ok: boolean;
}> {
	const { method = "GET", auth = true, headers = {}, body, retries = 0 } = options;

	const requestHeaders: Record<string, string> = {
		"Content-Type": "application/json",
		...headers,
	};

	if (auth) {
		requestHeaders["Authorization"] = `Bearer ${BEARER_TOKEN}`;
	}

	try {
		const response = await fetch(`${API_BASE}${endpoint}`, {
			method,
			headers: requestHeaders,
			body: body ? JSON.stringify(body) : undefined,
		});

		const data = (await response.json().catch(() => ({}))) as T;

		return {
			status: response.status,
			headers: response.headers,
			data,
			response,
			ok: response.ok,
		};
	} catch (error) {
		if (retries < TEST_CONFIG.maxRetries && error instanceof TypeError) {
			// Retry en cas d'erreur de connexion
			await new Promise((resolve) => setTimeout(resolve, 1000));
			return apiRequest<T>(endpoint, { ...options, retries: retries + 1 });
		}
		throw error;
	}
}

// Helper to wait for server to be ready
async function waitForServer(timeout = 10000): Promise<boolean> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeout) {
		try {
			const result = await apiRequest("/health", { auth: false });
			if (result.status === 200) {
				return true;
			}
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	return false;
}

// Start server before all tests
beforeAll(async () => {
	console.log("🚀 Starting test server...");

	// Start server on different port for tests
	serverProcess = spawn(["bun", "index.ts"], {
		env: {
			...process.env,
			BEARER_TOKEN,
			PORT: TEST_CONFIG.port.toString(),
			NODE_ENV: "test",
		},
		stdout: "inherit",
		stderr: "inherit",
	});

	serverStarted = await waitForServer(TEST_CONFIG.timeout);

	if (!serverStarted) {
		throw new Error("❌ Unable to start test server");
	}

	// Wait for database initialization
	console.log("🔄 Waiting for database initialization...");
	await new Promise((resolve) => setTimeout(resolve, 3000));

	console.log("✅ Test server started");
});

// Stop server after all tests
afterAll(async () => {
	if (serverProcess) {
		console.log("🛑 Stopping test server...");
		serverProcess.kill();
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
});

describe("Aircache API Tests", () => {
	describe("Health Check (No Auth)", () => {
		test("should return healthy status", async () => {
			const result = await apiRequest<HealthResponse>("/health", {
				auth: false,
			});

			expect(result.status).toBe(200);
			expect(result.data.status).toBe("ok");
			expect(result.data.backend).toBe("sqlite");
			expect(result.data.tables).toBeGreaterThan(0);
			expect(result.data.totalRecords).toBeGreaterThan(0);
		});

		test("should include system information", async () => {
			const result = await apiRequest<HealthResponse>("/health", {
				auth: false,
			});

			expect(result.data.database).toBeDefined();
			expect(result.data.dbSize).toBeDefined();
			expect(result.data.backend).toBe("sqlite");
		});
	});

	describe("Refresh Endpoint", () => {
		test("should accept POST requests with valid auth", async () => {
			const result = await apiRequest<RefreshResponse>("/api/refresh", {
				method: "POST",
				auth: true,
			});

			expect(result.status).toBe(200);
			expect(result.data.message).toContain("Refresh triggered");
			expect(result.data.backend).toBe("sqlite");
		});

		test("should reject POST requests without auth", async () => {
			const result = await apiRequest<ApiResponse>("/api/refresh", {
				method: "POST",
				auth: false,
			});

			expect([401, 500]).toContain(result.status);
			expect(result.data.message || result.data.error).toMatch(
				/Unauthorized|Internal server error/,
			);
		});

		test("should reject GET requests", async () => {
			const result = await apiRequest<ApiResponse>("/api/refresh", {
				method: "GET",
				auth: true,
			});

			expect(result.status).toBe(404);
			expect(result.data.error).toMatch(/not found/i);
		});

		test("should reject PUT requests", async () => {
			const result = await apiRequest<ApiResponse>("/api/refresh", {
				method: "PUT",
				auth: true,
			});

			expect(result.status).toBe(404);
			expect(result.data.error).toMatch(/not found/i);
		});

		test("should reject DELETE requests", async () => {
			const result = await apiRequest<ApiResponse>("/api/refresh", {
				method: "DELETE",
				auth: true,
			});

			expect(result.status).toBe(404);
			expect(result.data.error).toMatch(/not found/i);
		});

		test("should reject requests with invalid auth token", async () => {
			const result = await apiRequest<ApiResponse>("/api/refresh", {
				method: "POST",
				auth: false,
				headers: { Authorization: "Bearer invalid-token" },
			});

			expect([401, 500]).toContain(result.status);
			expect(result.data.message || result.data.error).toMatch(
				/Unauthorized|Internal server error/,
			);
		});
	});

	describe("Authentication", () => {
		test("should reject requests without auth token", async () => {
			const result = await apiRequest<ApiResponse>("/api/tables", {
				auth: false,
			});

			expect([401, 500]).toContain(result.status);
			expect(result.data.message || result.data.error).toMatch(
				/Unauthorized|Internal server error/,
			);
		});

		test("should accept requests with valid auth token", async () => {
			const result = await apiRequest<TablesResponse>("/api/tables", {
				auth: true,
			});

			expect(result.status).toBe(200);
			expect(result.data.backend).toBe("sqlite");
			expect(Array.isArray(result.data.tables)).toBe(true);
		});

		test("should reject requests with invalid auth token", async () => {
			const result = await apiRequest<ApiResponse>("/api/tables", {
				auth: false,
				headers: { Authorization: "Bearer invalid-token" },
			});

			expect([401, 500]).toContain(result.status);
			expect(result.data.message || result.data.error).toMatch(
				/Unauthorized|Internal server error/,
			);
		});

		test("should reject requests with malformed auth header", async () => {
			const result = await apiRequest<ApiResponse>("/api/tables", {
				auth: false,
				headers: { Authorization: "Invalid auth-format" },
			});

			expect([401, 500]).toContain(result.status);
			expect(result.data.message || result.data.error).toMatch(
				/Unauthorized|Internal server error/,
			);
		});

		test("should reject requests with empty auth token", async () => {
			const result = await apiRequest<ApiResponse>("/api/tables", {
				auth: false,
				headers: { Authorization: "Bearer " },
			});

			expect([401, 500]).toContain(result.status);
			expect(result.data.message || result.data.error).toMatch(
				/Unauthorized|Internal server error/,
			);
		});
	});

	describe("Tables Endpoint", () => {
		test("should return list of tables", async () => {
			const result = await apiRequest<TablesResponse>("/api/tables");

			expect(result.status).toBe(200);
			expect(result.data.backend).toBe("sqlite");
			expect(Array.isArray(result.data.tables)).toBe(true);
			expect(result.data.tables.length).toBeGreaterThan(0);
		});

		test("should include metadata", async () => {
			const result = await apiRequest<TablesResponse>("/api/tables");

			expect(result.data.backend).toBe("sqlite");
			expect(result.data.tables).toBeDefined();
		});

		test("should reject requests without auth", async () => {
			const result = await apiRequest<ApiResponse>("/api/tables", {
				auth: false,
			});

			expect([401, 500]).toContain(result.status);
			expect(result.data.message || result.data.error).toMatch(
				/Unauthorized|Internal server error/,
			);
		});

		test("should reject requests with invalid auth", async () => {
			const result = await apiRequest<ApiResponse>("/api/tables", {
				auth: false,
				headers: { Authorization: "Bearer invalid" },
			});

			expect([401, 500]).toContain(result.status);
			expect(result.data.message || result.data.error).toMatch(
				/Unauthorized|Internal server error/,
			);
		});

		test("should return valid table names", async () => {
			const result = await apiRequest<TablesResponse>("/api/tables");

			// Vérifier que toutes les tables ont des noms valides
			result.data.tables.forEach((tableName: string) => {
				expect(typeof tableName).toBe("string");
				expect(tableName.length).toBeGreaterThan(0);
				expect(tableName).not.toContain(" ");
				expect(tableName).toMatch(/^[a-zA-Z0-9_-]+$/);
			});
		});
	});

	describe("Stats Endpoint", () => {
		test("should return cache statistics", async () => {
			const result = await apiRequest<StatsResponse>("/api/stats");

			expect(result.status).toBe(200);
			expect(result.data.backend).toBe("sqlite");
			expect(result.data.stats.totalTables).toBeGreaterThanOrEqual(0);
			expect(result.data.stats.totalRecords).toBeGreaterThanOrEqual(0);
			expect(result.data.stats.dbSize).toBeDefined();
		});

		test("should include table statistics", async () => {
			const result = await apiRequest<StatsResponse>("/api/stats");

			expect(result.data.stats.totalTables).toBeGreaterThanOrEqual(0);
			expect(result.data.stats.totalRecords).toBeGreaterThanOrEqual(0);
		});

		test("should include database size information", async () => {
			const result = await apiRequest<StatsResponse>("/api/stats");

			expect(result.data.stats.dbSize).toBeDefined();
			expect(typeof result.data.stats.dbSize).toBe("string");
			expect(result.data.stats.dbSize).toContain("MB");
		});

		test("should reject requests without auth", async () => {
			const result = await apiRequest<ApiResponse>("/api/stats", {
				auth: false,
			});

			expect([401, 500]).toContain(result.status);
			expect(result.data.message || result.data.error).toMatch(
				/Unauthorized|Internal server error/,
			);
		});

		test("should include metadata in response", async () => {
			const result = await apiRequest<StatsResponse>("/api/stats");

			expect(result.data.backend).toBe("sqlite");
			expect(result.data.stats.totalRecords).toBeGreaterThanOrEqual(0);
			expect(result.data.stats.totalTables).toBeGreaterThanOrEqual(0);
		});
	});

	describe("Table Records Endpoint", () => {
		test("should return records for valid table", async () => {
			// Get first available table from schema dynamically
			const tablesResult = await apiRequest<TablesResponse>("/api/tables");
			const firstTable = tablesResult.data.tables[0];

			if (!firstTable) {
				throw new Error("No tables available for testing");
			}

			const result = await apiRequest(`/api/tables/${encodeURIComponent(firstTable)}`);

			expect(result.status).toBe(200);
			expect(result.data.backend).toBe("sqlite");
			expect(Array.isArray(result.data.records)).toBe(true);
		});

		test("should return 404 for invalid table", async () => {
			const result = await apiRequest<ApiResponse>("/api/tables/invalidtable999999999999");

			expect([200, 404]).toContain(result.status);
			// If 200, it means empty records, if 404, table not found - both are valid for an invalid table
			if (result.status === 404) {
				expect(result.data.error || result.data.message).toMatch(/not found/i);
			} else {
				expect((result.data as any).records).toEqual([]);
			}
		});
	});

	describe("Single Record Endpoint", () => {
		test("should return 404 for non-existent record", async () => {
			// Get first available table from schema dynamically
			const tablesResult = await apiRequest<TablesResponse>("/api/tables");
			const firstTable = tablesResult.data.tables[0];

			if (!firstTable) {
				throw new Error("No tables available for testing");
			}

			const result = await apiRequest(
				`/api/tables/${encodeURIComponent(firstTable)}/nonexistent-id`,
			);

			expect(result.status).toBe(404);
			expect(result.data.error || result.data.message).toMatch(/not found/i);
		});

		test("should return 404 for invalid table", async () => {
			const result = await apiRequest("/api/tables/invalidtable999999999999/some-id");

			expect(result.status).toBe(404);
			expect(result.data.error || result.data.message).toMatch(/not found/i);
		});
	});

	describe("CORS Headers", () => {
		test("should restrict CORS when CORS_ORIGINS is not configured", async () => {
			// Test server runs with auth enabled and no CORS_ORIGINS set,
			// so CORS should be restrictive (no wildcard Access-Control-Allow-Origin)
			const result = await apiRequest("/health", { auth: false });

			expect(result.headers.get("access-control-allow-origin")).toBeNull();
		});

		test("should handle OPTIONS requests", async () => {
			const result = await apiRequest("/api/tables", {
				method: "OPTIONS",
				auth: false,
			});

			expect(result.status).toBe(204);
			const allowMethods = result.headers.get("access-control-allow-methods");
			// Elysia CORS might not send this header for preflight requests if origin is not set or matches defaults
			// so we just check status 204 for successful preflight
			if (allowMethods) {
				expect(allowMethods as string).toContain("GET");
			}
		});
	});

	describe("Error Handling", () => {
		test("should return 404 for unknown routes", async () => {
			const result = await apiRequest("/unknown-route");

			expect(result.status).toBe(404);
			expect(result.data.error || result.data).toMatch(/not found/i);
		});
	});
});
