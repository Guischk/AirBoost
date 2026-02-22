#!/usr/bin/env bun

/**
 * Tests de performance pour Airboost
 * Benchmarks et tests de charge
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Subprocess, spawn } from "bun";
import { performance } from "perf_hooks";

const API_BASE = "http://localhost:3004";
const BEARER_TOKEN = process.env.BEARER_TOKEN || "dev-token";

let serverProcess: Subprocess | null = null;

interface BenchmarkResult {
	endpoint: string;
	method: string;
	requests: number;
	totalTime: number;
	avgResponseTime: number;
	minResponseTime: number;
	maxResponseTime: number;
	p95ResponseTime: number;
	requestsPerSecond: number;
	successCount: number;
	errorCount: number;
	errors: string[];
}

async function apiRequest(
	endpoint: string,
	method = "GET",
): Promise<{
	success: boolean;
	responseTime: number;
	status: number;
	error?: string;
}> {
	const startTime = performance.now();

	try {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${BEARER_TOKEN}`,
		};

		const response = await fetch(`${API_BASE}${endpoint}`, {
			method,
			headers,
		});

		const responseTime = performance.now() - startTime;

		return {
			success: response.ok,
			responseTime,
			status: response.status,
		};
	} catch (error) {
		const responseTime = performance.now() - startTime;
		return {
			success: false,
			responseTime,
			status: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function runBenchmark(
	endpoint: string,
	options: {
		method?: string;
		requests?: number;
		concurrency?: number;
		timeout?: number;
	},
): Promise<BenchmarkResult> {
	const { method = "GET", requests = 100, concurrency = 10, timeout = 30000 } = options;

	console.log(
		`🧪 Benchmarking ${method} ${endpoint} (${requests} requests, ${concurrency} concurrent)`,
	);

	const results: number[] = [];
	const errors: string[] = [];
	let successCount = 0;
	let errorCount = 0;

	const startTime = performance.now();

	// Run requests in batches to control concurrency
	for (let i = 0; i < requests; i += concurrency) {
		const batch = Math.min(concurrency, requests - i);
		const promises = Array.from({ length: batch }, () => apiRequest(endpoint, method));

		const batchResults = await Promise.all(promises);

		for (const result of batchResults) {
			results.push(result.responseTime);

			if (result.success) {
				successCount++;
			} else {
				errorCount++;
				if (result.error) {
					errors.push(result.error);
				}
			}
		}

		// Small delay between batches to avoid overwhelming
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	const totalTime = performance.now() - startTime;

	results.sort((a, b) => a - b);
	const p95Index = Math.floor(results.length * 0.95);

	return {
		endpoint,
		method,
		requests,
		totalTime,
		avgResponseTime: results.reduce((a, b) => a + b, 0) / results.length,
		minResponseTime: results[0],
		maxResponseTime: results[results.length - 1],
		p95ResponseTime: results[p95Index],
		requestsPerSecond: (requests / totalTime) * 1000,
		successCount,
		errorCount,
		errors: [...new Set(errors)], // Remove duplicates
	};
}

beforeAll(async () => {
	serverProcess = spawn(["bun", "index.ts"], {
		env: { ...process.env, BEARER_TOKEN, PORT: "3004", NODE_ENV: "test" },
		stdout: "pipe",
		stderr: "pipe",
	});

	await new Promise((resolve) => setTimeout(resolve, 5000));
});

afterAll(() => {
	if (serverProcess) serverProcess.kill();
});

describe("Performance Tests", () => {
	describe("Baseline Performance Tests", () => {
		test("health endpoint should respond quickly", async () => {
			const result = await runBenchmark("/health", {
				method: "GET",
				requests: 50,
				concurrency: 5,
			});

			expect(result.successCount).toBe(50);
			expect(result.errorCount).toBe(0);
			expect(result.avgResponseTime).toBeLessThan(100); // < 100ms average
			expect(result.p95ResponseTime).toBeLessThan(200); // < 200ms 95th percentile
			expect(result.requestsPerSecond).toBeGreaterThan(10); // > 10 RPS

			console.log("📊 Health endpoint results:", result);
		});

		test("tables endpoint should handle moderate load", async () => {
			const result = await runBenchmark("/api/tables", {
				method: "GET",
				requests: 30,
				concurrency: 3,
			});

			expect(result.successCount).toBe(30);
			expect(result.errorCount).toBe(0);
			expect(result.avgResponseTime).toBeLessThan(500); // < 500ms average
			expect(result.p95ResponseTime).toBeLessThan(1000); // < 1s 95th percentile

			console.log("📊 Tables endpoint results:", result);
		});

		test("stats endpoint performance", async () => {
			const result = await runBenchmark("/api/stats", {
				method: "GET",
				requests: 25,
				concurrency: 2,
			});

			expect(result.successCount).toBe(25);
			expect(result.errorCount).toBe(0);
			expect(result.avgResponseTime).toBeLessThan(300); // < 300ms average

			console.log("📊 Stats endpoint results:", result);
		});
	});

	describe("Load Testing", () => {
		test("should handle sustained load", async () => {
			const result = await runBenchmark("/health", {
				method: "GET",
				requests: 200,
				concurrency: 20,
				timeout: 60000,
			});

			expect(result.successCount).toBeGreaterThan(190); // > 95% success rate
			expect(result.errorCount).toBeLessThan(10); // < 5% error rate
			expect(result.avgResponseTime).toBeLessThan(200); // < 200ms average under load
			expect(result.requestsPerSecond).toBeGreaterThan(20); // > 20 RPS sustained

			console.log("📊 Load test results:", result);
		});

		test("should handle concurrent users", async () => {
			// Simulate multiple concurrent users
			const userCount = 10;
			const requestsPerUser = 5;

			const userPromises = Array.from({ length: userCount }, (_, userId) =>
				Promise.all(
					Array.from({ length: requestsPerUser }, () =>
						apiRequest(`/health?t=${userId}_${Date.now()}`),
					),
				),
			);

			const userResults = await Promise.all(userPromises);

			let totalRequests = 0;
			let totalSuccess = 0;
			let totalErrors = 0;
			let totalResponseTime = 0;

			for (const userResult of userResults) {
				totalRequests += userResult.length;

				for (const request of userResult) {
					if (request.success) {
						totalSuccess++;
					} else {
						totalErrors++;
					}
					totalResponseTime += request.responseTime;
				}
			}

			const successRate = (totalSuccess / totalRequests) * 100;
			const avgResponseTime = totalResponseTime / totalRequests;

			expect(successRate).toBeGreaterThan(95); // > 95% success rate
			expect(avgResponseTime).toBeLessThan(150); // < 150ms average under concurrency

			console.log(
				`📊 Concurrent users test: ${totalSuccess}/${totalRequests} successful (${successRate.toFixed(1)}%)`,
			);
			console.log(`⚡ Average response time: ${avgResponseTime.toFixed(2)}ms`);
		});
	});

	describe("Stress Testing", () => {
		test("should handle high concurrency", async () => {
			const result = await runBenchmark("/health", {
				method: "GET",
				requests: 100,
				concurrency: 50, // High concurrency
				timeout: 45000,
			});

			// Under high stress, some degradation is acceptable
			expect(result.successCount).toBeGreaterThan(80); // > 80% success rate
			expect(result.avgResponseTime).toBeLessThan(1000); // < 1s average
			expect(result.requestsPerSecond).toBeGreaterThan(5); // > 5 RPS minimum

			console.log("📊 Stress test results:", result);
		});

		test("should recover from stress", async () => {
			// Apply stress
			await runBenchmark("/health", {
				requests: 50,
				concurrency: 25,
				timeout: 10000,
			});

			// Test recovery with normal load
			const recoveryResult = await runBenchmark("/health", {
				requests: 20,
				concurrency: 3,
				timeout: 15000,
			});

			expect(recoveryResult.successCount).toBe(20);
			expect(recoveryResult.errorCount).toBe(0);
			expect(recoveryResult.avgResponseTime).toBeLessThan(200); // Should recover to normal

			console.log("📊 Recovery test results:", recoveryResult);
		});
	});

	describe("Memory and Resource Usage", () => {
		test("should not leak memory under sustained load", async () => {
			const initialMemory = process.memoryUsage();

			// Run sustained load
			await runBenchmark("/health", {
				requests: 100,
				concurrency: 10,
				timeout: 20000,
			});

			const finalMemory = process.memoryUsage();
			const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;

			// Memory increase should be reasonable (less than 50MB)
			expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);

			console.log(
				`📊 Memory usage: ${initialMemory.heapUsed / 1024 / 1024}MB -> ${finalMemory.heapUsed / 1024 / 1024}MB`,
			);
			console.log(`⚡ Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`);
		});
	});

	describe("Endpoint-Specific Performance", () => {
		test("refresh endpoint should handle load", async () => {
			const result = await runBenchmark("/api/refresh", {
				method: "POST",
				requests: 10,
				concurrency: 1, // Refresh is typically called less frequently
				timeout: 60000,
			});

			expect(result.successCount).toBe(10);
			expect(result.errorCount).toBe(0);
			expect(result.avgResponseTime).toBeLessThan(2000); // < 2s average for refresh

			console.log("📊 Refresh endpoint results:", result);
		});

		test("table records endpoint performance", async () => {
			// First get available tables
			const tablesResult = await apiRequest("/api/tables");
			const firstTable = tablesResult.data.data.tables[0];

			if (firstTable) {
				const result = await runBenchmark(`/api/tables/${encodeURIComponent(firstTable)}`, {
					requests: 20,
					concurrency: 5,
					timeout: 30000,
				});

				expect(result.successCount).toBe(20);
				expect(result.avgResponseTime).toBeLessThan(1000); // < 1s average

				console.log(`📊 Table records endpoint results (${firstTable}):`, result);
			}
		});
	});
});
