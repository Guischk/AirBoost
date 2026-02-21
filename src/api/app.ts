/**
 * 🚀 Elysia Application for Aircache
 * Main application setup with routes and middleware
 */

import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { config } from "../config";
import { loggers } from "../lib/logger";

// Import endpoints
import { attachments } from "./endpoints/attachments";
import { health } from "./endpoints/health";
import { mappings } from "./endpoints/mappings";
import { refresh } from "./endpoints/refresh";
import { stats } from "./endpoints/stats";
import { tables } from "./endpoints/tables";
import { types } from "./endpoints/types";
import { webhooks } from "./endpoints/webhooks";

// Import middleware
import { bearerAuth } from "./middleware/auth";

const log = loggers.api;

/**
 * Create and configure the Elysia application
 */
export function createApp(worker?: Worker) {
	const app = new Elysia()
		// 🧩 Swagger Documentation
		.use(
			swagger({
				documentation: {
					info: {
						title: "Aircache API",
						version: "0.2.0",
						description: "High-performance Airtable cache service built with SQLite and Bun",
					},
					security: [{ BearerAuth: [] }],
					components: {
						securitySchemes: {
							BearerAuth: {
								type: "http",
								scheme: "bearer",
							},
						},
					},
				},
				path: "/docs",
			}),
		)

		// 🌐 CORS
		.use(
			cors({
				methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
				allowedHeaders: ["Content-Type", "Authorization"],
				origin:
					config.corsOrigins.length > 0 ? config.corsOrigins : config.authDisabled ? true : false,
				preflight: true,
			}),
		)

		// 📝 Request logging
		.derive(({ request }) => {
			return {
				start: performance.now(),
			};
		})
		.onAfterHandle(({ request, path, set, start }) => {
			const status = set.status || 200;
			const duration = performance.now() - start;
			log.info(`${request.method} ${path} ${status} - ${duration.toFixed(2)}ms`);
		})

		// ❌ Global Error Handling
		.onError(({ code, error, set }) => {
			if (code === "NOT_FOUND") {
				set.status = 404;
				return {
					error: "Not Found",
					backend: "sqlite",
				};
			}

			if (code === "VALIDATION") {
				set.status = 400;
				return {
					error: "Validation Error",
					details: JSON.parse(error.message),
					backend: "sqlite",
				};
			}

			log.error(`API Error [${code}]:`, error);
			set.status = 500;
			return {
				error: "Internal Server Error",
				message: error instanceof Error ? error.message : "Unknown error",
				backend: "sqlite",
			};
		})

		// 🌍 Global State
		.state("worker", worker)

		// 🔓 Public Routes
		.use(health)
		.use(webhooks)

		// 🔒 Protected Routes (Bearer Token)
		.use(bearerAuth)
		.use(tables)
		.use(refresh)
		.use(stats)
		.use(attachments)
		.use(mappings)
		.use(types);

	return app;
}

export type App = ReturnType<typeof createApp>;
