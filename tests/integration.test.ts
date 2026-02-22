#!/usr/bin/env bun

/**
 * Tests d'intégration complets pour Airboost
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Subprocess, spawn } from "bun";

const API_BASE = "http://localhost:3002";
const BEARER_TOKEN = process.env.BEARER_TOKEN || "dev-token";

let serverProcess: Subprocess | null = null;

async function apiRequest(endpoint: string, auth = true) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (auth) {
		headers["Authorization"] = `Bearer ${BEARER_TOKEN}`;
	}

	const response = await fetch(`${API_BASE}${endpoint}`, { headers });
	return { status: response.status, data: await response.json() };
}

beforeAll(async () => {
	// Démarrer le serveur pour les tests d'intégration
	serverProcess = spawn(["bun", "index.ts"], {
		env: { ...process.env, BEARER_TOKEN, PORT: "3002", NODE_ENV: "test" },
		stdout: "pipe",
		stderr: "pipe",
	});

	// Attendre que le serveur démarre
	await new Promise((resolve) => setTimeout(resolve, 5000));
});

afterAll(() => {
	if (serverProcess) serverProcess.kill();
});

interface ApiResponse {
	success: boolean;
	data: any;
	error?: string;
	message?: string;
	code?: string;
	meta?: {
		timestamp: string;
		version?: string;
	};
}

describe("Integration Tests", () => {
	test("should complete full workflow", async () => {
		const health = await apiRequest("/health", false);
		expect(health.status).toBe(200);

		const tables = await apiRequest("/api/tables");
		expect(tables.status).toBe(200);
		expect(Array.isArray((tables.data as any).tables)).toBe(true);

		const stats = await apiRequest("/api/stats");
		expect(stats.status).toBe(200);
		expect((stats.data as any).stats.totalTables).toBeGreaterThanOrEqual(0);
	});
});
