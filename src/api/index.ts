/**
 * 🚀 Elysia-based API server for Airboost
 * Provides REST endpoints for cached Airtable data using Elysia framework
 */

import { loggers } from "../lib/logger";
import { createApp } from "./app";

const logger = loggers.server;

/**
 * 🚀 API SERVER STARTUP WITH ELYSIA
 *
 * This function initializes the Bun server with Elysia:
 * - Creates Elysia application with all routes
 * - Configures Bun.serve() to use Elysia's fetch handler
 * - Passes worker instance to Elysia context
 */
export async function startSQLiteApiServer(port: number, worker?: Worker): Promise<void> {
	logger.start("Starting Elysia API server", { port });

	// 🚀 Create Elysia application with all routes and middleware
	const app = createApp(worker);

	// 🌐 BUN SERVER CONFIGURATION WITH ELYSIA
	Bun.serve({
		port, // Configurable port via environment
		hostname: "0.0.0.0", // Listen on all interfaces
		fetch: app.fetch, // 🔑 Use Elysia's fetch handler
	});

	logger.success("Elysia API server started", {
		url: `http://localhost:${port}`,
		docs: `http://localhost:${port}/docs`,
		healthCheck: `http://localhost:${port}/health`,
		tables: `http://localhost:${port}/api/tables`,
		stats: `http://localhost:${port}/api/stats`,
		refresh: `POST http://localhost:${port}/api/refresh`,
	});
}
