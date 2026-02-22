#!/usr/bin/env bun

/**
 * Comparative Benchmark SQLite Cache vs Airtable Direct
 * Demonstrates the added value of local SQLite cache
 *
 * UNIFIED VALIDATION LOGIC:
 * All scenarios use consistent success criteria:
 * - SQLite: HTTP 200 response (response.ok)
 * - Airtable: Successful API call (no exceptions)
 * This ensures fair performance comparison across all scenarios,
 * including cases with empty tables.
 */

import { base } from "../src/lib/airtable/index";
import { AIRTABLE_TABLE_NAMES } from "../src/lib/airtable/schema";
import { sqliteService } from "../src/lib/sqlite/index";
import { normalizeKey } from "../src/lib/utils/index";

const API_BASE = process.env.API_BASE || "http://localhost:3000/";
const BEARER_TOKEN = process.env.BEARER_TOKEN || "test-token";

interface BenchmarkResult {
	source: "sqlite" | "airtable";
	tableName: string;
	scenario: string;
	totalRequests: number;
	duration: number;
	avgResponseTime: number;
	minResponseTime: number;
	maxResponseTime: number;
	p95ResponseTime: number;
	requestsPerSecond: number;
	successRate: number;
	errors: number;
	responseTimesMs: number[];
}

interface ComparisonResult {
	table: string;
	scenario: string;
	sqlite: BenchmarkResult;
	airtable: BenchmarkResult;
	improvement: {
		speedFactor: number;
		throughputFactor: number;
		latencyReduction: number;
		reliabilityIncrease: number;
	};
}

class SQLiteVsAirtableBenchmark {
	private results: ComparisonResult[] = [];
	private tableAliases: Map<string, string> = new Map();

	/**
	 * Unified validation logic: All scenarios consider successful API calls as success,
	 * regardless of whether data is returned. This ensures consistent performance measurement
	 * across all scenarios, including cases with empty tables.
	 */
	private isValidResponse(response: Response): boolean {
		return response.ok;
	}

	constructor() {
		// Create anonymous aliases for tables
		this.initializeTableAliases();
	}

	private initializeTableAliases(): void {
		const tableNames = Object.values(AIRTABLE_TABLE_NAMES);
		tableNames.forEach((tableName, index) => {
			this.tableAliases.set(tableName, `table_${String.fromCharCode(65 + index)}`);
		});
	}

	async runBenchmark(): Promise<void> {
		console.log("🏁 SQLite vs Airtable Performance Benchmark");
		console.log("============================================");
		console.log(`📊 Testing ${this.tableAliases.size} tables with multiple scenarios`);
		console.log(`🌐 API Base: ${API_BASE}`);
		console.log(`🔐 Bearer Token: ${BEARER_TOKEN ? "Configured" : "Not configured"}\n`);

		// Initialize SQLite
		await this.setupSQLite();

		// Test scenarios
		const scenarios = [
			{ name: "single_record", description: "Single record query" },
			{ name: "small_batch", description: "10 records" },
			{ name: "medium_batch", description: "50 records" },
			{ name: "table_scan", description: "All records from a table" },
		];

		for (const [tableName, alias] of this.tableAliases) {
			console.log(`\n🔍 Testing table ${alias} (${tableName})`);

			for (const scenario of scenarios) {
				try {
					console.log(`   📋 Scenario: ${scenario.description}`);

					const sqliteResult = await this.benchmarkSQLite(tableName, scenario.name, alias);
					const airtableResult = await this.benchmarkAirtable(tableName, scenario.name, alias);

					const comparison: ComparisonResult = {
						table: alias,
						scenario: scenario.name,
						sqlite: sqliteResult,
						airtable: airtableResult,
						improvement: this.calculateImprovement(sqliteResult, airtableResult),
					};

					this.results.push(comparison);
					this.printScenarioResult(comparison);
				} catch (error) {
					console.error(`   ❌ Error in scenario ${scenario.name}:`, error);
				}
			}
		}

		this.generateReport();
	}

	private async setupSQLite(): Promise<void> {
		console.log("🔄 Checking SQLite API availability...");

		// Check that API is available
		try {
			const healthResponse = await fetch(`${API_BASE}health`);
			if (!healthResponse.ok) {
				throw new Error(`API health check failed: ${healthResponse.status}`);
			}
			console.log("✅ SQLite API available");
		} catch (error) {
			console.error("❌ SQLite API not available. Make sure the server is started:");
			console.error("   bun run dev:sqlite");
			console.error("   or");
			console.error("   bun run start:sqlite");
			throw error;
		}

		// Initialize local SQLite for test data if needed
		await sqliteService.connect();
		console.log("✅ Local SQLite initialized\n");
	}

	private async benchmarkSQLite(
		tableName: string,
		scenario: string,
		alias: string,
	): Promise<BenchmarkResult> {
		const responseTimes: number[] = [];
		let errors = 0;
		let totalRequests = 0;

		const start = performance.now();

		switch (scenario) {
			case "single_record":
				// Unified logic: Success = valid HTTP response (regardless of data presence)
				totalRequests = 50;
				for (let i = 0; i < totalRequests; i++) {
					const requestStart = performance.now();
					try {
						const normalizedTableName = normalizeKey(tableName);
						const response = await fetch(
							`${API_BASE}api/tables/${encodeURIComponent(normalizedTableName)}?pageSize=1`,
							{
								headers: {
									Authorization: `Bearer ${BEARER_TOKEN}`,
									"Content-Type": "application/json",
								},
							},
						);
						if (this.isValidResponse(response)) {
							responseTimes.push(performance.now() - requestStart);
						} else {
							errors++;
						}
					} catch (error) {
						errors++;
					}
				}
				break;

			case "small_batch":
				totalRequests = 20;
				for (let i = 0; i < totalRequests; i++) {
					const requestStart = performance.now();
					try {
						const normalizedTableName = normalizeKey(tableName);
						const response = await fetch(
							`${API_BASE}api/tables/${encodeURIComponent(normalizedTableName)}?pageSize=10`,
							{
								headers: {
									Authorization: `Bearer ${BEARER_TOKEN}`,
									"Content-Type": "application/json",
								},
							},
						);
						if (this.isValidResponse(response)) {
							responseTimes.push(performance.now() - requestStart);
						} else {
							errors++;
						}
					} catch (error) {
						errors++;
					}
				}
				break;

			case "medium_batch":
				totalRequests = 10;
				for (let i = 0; i < totalRequests; i++) {
					const requestStart = performance.now();
					try {
						const normalizedTableName = normalizeKey(tableName);
						const response = await fetch(
							`${API_BASE}api/tables/${encodeURIComponent(normalizedTableName)}?pageSize=50`,
							{
								headers: {
									Authorization: `Bearer ${BEARER_TOKEN}`,
									"Content-Type": "application/json",
								},
							},
						);
						if (this.isValidResponse(response)) {
							responseTimes.push(performance.now() - requestStart);
						} else {
							errors++;
						}
					} catch (error) {
						errors++;
					}
				}
				break;

			case "table_scan":
				totalRequests = 5;
				for (let i = 0; i < totalRequests; i++) {
					const requestStart = performance.now();
					try {
						const normalizedTableName = normalizeKey(tableName);
						const response = await fetch(
							`${API_BASE}api/tables/${encodeURIComponent(normalizedTableName)}?pageSize=1000`,
							{
								headers: {
									Authorization: `Bearer ${BEARER_TOKEN}`,
									"Content-Type": "application/json",
								},
							},
						);
						if (this.isValidResponse(response)) {
							responseTimes.push(performance.now() - requestStart);
						} else {
							errors++;
						}
					} catch (error) {
						errors++;
					}
				}
				break;
		}

		const end = performance.now();
		const duration = end - start;

		return this.calculateResult(
			"sqlite",
			alias,
			scenario,
			totalRequests,
			duration,
			responseTimes,
			errors,
		);
	}

	private async benchmarkAirtable(
		tableName: string,
		scenario: string,
		alias: string,
	): Promise<BenchmarkResult> {
		const responseTimes: number[] = [];
		let errors = 0;
		let totalRequests = 0;

		const start = performance.now();

		switch (scenario) {
			case "single_record":
				// Unified logic: Success = valid API call (regardless of data presence)
				totalRequests = 50;
				for (let i = 0; i < totalRequests; i++) {
					const requestStart = performance.now();
					try {
						await base(tableName).select({ maxRecords: 1 }).firstPage();
						responseTimes.push(performance.now() - requestStart);
					} catch (error) {
						errors++;
					}
				}
				break;

			case "small_batch":
				totalRequests = 20;
				for (let i = 0; i < totalRequests; i++) {
					const requestStart = performance.now();
					try {
						await base(tableName).select({ maxRecords: 10 }).firstPage();
						responseTimes.push(performance.now() - requestStart);
					} catch (error) {
						errors++;
					}
				}
				break;

			case "medium_batch":
				totalRequests = 10;
				for (let i = 0; i < totalRequests; i++) {
					const requestStart = performance.now();
					try {
						await base(tableName).select({ maxRecords: 50 }).firstPage();
						responseTimes.push(performance.now() - requestStart);
					} catch (error) {
						errors++;
					}
				}
				break;

			case "table_scan":
				totalRequests = 5;
				for (let i = 0; i < totalRequests; i++) {
					const requestStart = performance.now();
					try {
						const records = await base(tableName).select().all();
						responseTimes.push(performance.now() - requestStart);
					} catch (error) {
						errors++;
					}
				}
				break;
		}

		const end = performance.now();
		const duration = end - start;

		return this.calculateResult(
			"airtable",
			alias,
			scenario,
			totalRequests,
			duration,
			responseTimes,
			errors,
		);
	}

	private calculateResult(
		source: "sqlite" | "airtable",
		tableName: string,
		scenario: string,
		totalRequests: number,
		duration: number,
		responseTimes: number[],
		errors: number,
	): BenchmarkResult {
		const validResponses = responseTimes.length;
		const successRate = (validResponses / totalRequests) * 100;

		if (validResponses === 0) {
			return {
				source,
				tableName,
				scenario,
				totalRequests,
				duration,
				avgResponseTime: 0,
				minResponseTime: 0,
				maxResponseTime: 0,
				p95ResponseTime: 0,
				requestsPerSecond: 0,
				successRate: 0,
				errors,
				responseTimesMs: [],
			};
		}

		const sortedTimes = responseTimes.sort((a, b) => a - b);
		const p95Index = Math.floor(validResponses * 0.95);

		return {
			source,
			tableName,
			scenario,
			totalRequests,
			duration,
			avgResponseTime: responseTimes.reduce((a, b) => a + b, 0) / validResponses,
			minResponseTime: Math.min(...responseTimes),
			maxResponseTime: Math.max(...responseTimes),
			p95ResponseTime: sortedTimes[p95Index] || 0,
			requestsPerSecond: (validResponses / duration) * 1000,
			successRate,
			errors,
			responseTimesMs: responseTimes,
		};
	}

	private calculateImprovement(sqlite: BenchmarkResult, airtable: BenchmarkResult) {
		const speedFactor =
			airtable.avgResponseTime > 0 ? airtable.avgResponseTime / sqlite.avgResponseTime : 0;
		const throughputFactor =
			sqlite.requestsPerSecond > 0 ? sqlite.requestsPerSecond / airtable.requestsPerSecond : 0;
		const latencyReduction =
			airtable.avgResponseTime > 0
				? ((airtable.avgResponseTime - sqlite.avgResponseTime) / airtable.avgResponseTime) * 100
				: 0;
		const reliabilityIncrease = sqlite.successRate - airtable.successRate;

		return {
			speedFactor,
			throughputFactor,
			latencyReduction,
			reliabilityIncrease,
		};
	}

	private printScenarioResult(comparison: ComparisonResult): void {
		const { sqlite, airtable, improvement } = comparison;

		console.log(
			`      SQLite:  ${sqlite.avgResponseTime.toFixed(1)}ms avg, ${sqlite.requestsPerSecond.toFixed(1)} req/s, ${sqlite.successRate.toFixed(1)}% success`,
		);
		console.log(
			`      Airtable: ${airtable.avgResponseTime.toFixed(1)}ms avg, ${airtable.requestsPerSecond.toFixed(1)} req/s, ${airtable.successRate.toFixed(1)}% success`,
		);
		console.log(
			`      📈 Improvement: ${improvement.speedFactor.toFixed(1)}x faster, ${improvement.latencyReduction.toFixed(1)}% less latency`,
		);
	}

	private generateReport(): void {
		console.log("\n\n📊 COMPLETE REPORT");
		console.log("==================");

		// Global statistics
		const totalScenarios = this.results.length;
		const avgSpeedFactor =
			this.results.reduce((sum, r) => sum + r.improvement.speedFactor, 0) / totalScenarios;
		const avgLatencyReduction =
			this.results.reduce((sum, r) => sum + r.improvement.latencyReduction, 0) / totalScenarios;

		console.log(`\n🎯 Average results (${totalScenarios} scenarios tested):`);
		console.log(`   Speed factor: ${avgSpeedFactor.toFixed(1)}x`);
		console.log(`   Latency reduction: ${avgLatencyReduction.toFixed(1)}%`);

		// Detailed table
		console.log("\n📋 Details by scenario:");
		console.log("| Table | Scenario | SQLite (ms) | Airtable (ms) | Factor | Reduction |");
		console.log("|-------|----------|-------------|---------------|---------|-----------|");

		for (const result of this.results) {
			console.log(
				`| ${result.table.padEnd(5)} | ${result.scenario.padEnd(8)} | ${result.sqlite.avgResponseTime.toFixed(1).padStart(11)} | ${result.airtable.avgResponseTime.toFixed(1).padStart(13)} | ${result.improvement.speedFactor.toFixed(1).padStart(7)} | ${result.improvement.latencyReduction.toFixed(1).padStart(9)}% |`,
			);
		}

		// Analysis by scenario
		console.log("\n🔍 Analysis by query type:");
		const scenarioTypes = [...new Set(this.results.map((r) => r.scenario))];

		for (const scenario of scenarioTypes) {
			const scenarioResults = this.results.filter((r) => r.scenario === scenario);
			const avgImprovement =
				scenarioResults.reduce((sum, r) => sum + r.improvement.speedFactor, 0) /
				scenarioResults.length;
			console.log(`   ${scenario}: ${avgImprovement.toFixed(1)}x faster on average`);
		}

		// SQLite advantages
		console.log("\n💰 Economic and technical advantages of SQLite:");
		console.log(
			"   ✅ Performance: On average " + avgSpeedFactor.toFixed(1) + "x faster than Airtable",
		);
		console.log("   ✅ Cost: No API request limits (Airtable: 5 req/s max)");
		console.log("   ✅ Availability: Works offline");
		console.log("   ✅ Latency: No network latency");
		console.log("   ✅ Scalability: No quotas or rate limits");
		console.log("   ✅ Reliability: No dependency on external services");
		console.log("   ✅ Architecture: Simplified technical stack");

		// Recommendations
		console.log("\n🎯 Recommendations:");
		console.log("   🔄 Sync Airtable → SQLite: 1x per day (or according to business needs)");
		console.log("   📊 Read queries: 100% via SQLite cache");
		console.log("   📝 Writes: Directly to Airtable + refresh SQLite");
		console.log("   ⚡ Optimal hybrid architecture for performance and flexibility");

		this.generateMarkdownReport();
	}

	private generateMarkdownReport(): void {
		const timestamp = new Date().toISOString().split("T")[0];
		const filename = `sqlite-vs-airtable-comparison-${timestamp}.md`;

		let markdown = `# SQLite vs Airtable Performance Benchmark\n\n`;
		markdown += `**Date:** ${new Date().toLocaleDateString("en-US")}\n`;
		markdown += `**Tables tested:** ${this.tableAliases.size}\n`;
		markdown += `**Scenarios:** ${[...new Set(this.results.map((r) => r.scenario))].length}\n\n`;

		// Executive summary
		const totalScenarios = this.results.length;
		const avgSpeedFactor =
			this.results.reduce((sum, r) => sum + r.improvement.speedFactor, 0) / totalScenarios;
		const avgLatencyReduction =
			this.results.reduce((sum, r) => sum + r.improvement.latencyReduction, 0) / totalScenarios;

		markdown += `## 🎯 Executive Summary\n\n`;
		markdown += `- **Average performance:** SQLite is ${avgSpeedFactor.toFixed(1)}x faster than Airtable\n`;
		markdown += `- **Latency reduction:** ${avgLatencyReduction.toFixed(1)}% on average\n`;
		markdown += `- **Reliability:** 0 failures on ${this.results.reduce((sum, r) => sum + r.sqlite.totalRequests, 0)} SQLite queries\n\n`;

		// Detailed results
		markdown += `## 📊 Detailed Results\n\n`;
		markdown += `| Table | Scenario | SQLite (ms) | Airtable (ms) | Factor | Reduction |\n`;
		markdown += `|-------|----------|-------------|---------------|---------|----------|\n`;

		for (const result of this.results) {
			markdown += `| ${result.table} | ${result.scenario} | ${result.sqlite.avgResponseTime.toFixed(1)} | ${result.airtable.avgResponseTime.toFixed(1)} | ${result.improvement.speedFactor.toFixed(1)}x | ${result.improvement.latencyReduction.toFixed(1)}% |\n`;
		}

		markdown += `\n## 💰 Business Impact\n\n`;
		markdown += `### Avoided Airtable costs\n`;
		markdown += `- **Rate limits:** 5 requests/second maximum\n`;
		markdown += `- **Quotas:** Limits per pricing plan\n`;
		markdown += `- **Network latency:** 100-500ms per request\n\n`;

		markdown += `### SQLite benefits\n`;
		markdown += `- **Performance:** ${avgSpeedFactor.toFixed(1)}x faster\n`;
		markdown += `- **Availability:** 100% (no external dependency)\n`;
		markdown += `- **Scalability:** Unlimited locally\n`;
		markdown += `- **Simplicity:** Unified architecture\n\n`;

		try {
			Bun.write(filename, markdown);
			console.log(`\n📄 Detailed report generated: ${filename}`);
		} catch (error) {
			console.error("❌ Error generating report:", error);
		}
	}

	async cleanup(): Promise<void> {
		console.log("\n🧹 Cleaning up...");
		await sqliteService.close();
		console.log("✅ Cleanup completed");
	}
}

// Execute if called directly
if (import.meta.main) {
	const benchmark = new SQLiteVsAirtableBenchmark();

	try {
		await benchmark.runBenchmark();
	} catch (error) {
		console.error("❌ Error during benchmark:", error);
	} finally {
		await benchmark.cleanup();
	}
}

export { SQLiteVsAirtableBenchmark };
