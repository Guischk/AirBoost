/**
 * Configuration for all Airboost tests
 */

export const TEST_CONFIG = {
	// Test server configuration
	server: {
		port: 3001,
		host: "localhost",
		timeout: 30000,
		maxRetries: 3,
	},

	// Configuration de l'API
	api: {
		baseUrl: "http://localhost:3001",
		bearerToken: "test-token",
		defaultTimeout: 5000,
	},

	// Configuration des tests
	tests: {
		enablePerformanceTests: process.env.ENABLE_PERFORMANCE_TESTS !== "false",
		enableIntegrationTests: process.env.ENABLE_INTEGRATION_TESTS !== "false",
		enableSecurityTests: process.env.ENABLE_SECURITY_TESTS !== "false",
		runParallel: process.env.NODE_ENV === "test" && process.env.CI !== "true",
		maxConcurrency: Number.parseInt(process.env.TEST_CONCURRENCY || "5"),
	},

	// Configuration des benchmarks
	benchmarks: {
		minSuccessRate: 0.95, // 95% de succès minimum
		maxResponseTime: 1000, // 1 seconde maximum
		minRequestsPerSecond: 10, // 10 RPS minimum
		loadTestDuration: 30000, // 30 secondes
		stressTestConcurrency: 50, // 50 utilisateurs simultanés
	},

	// Configuration des tests de sécurité
	security: {
		maxTableNameLength: 100,
		maxRecordIdLength: 100,
		allowedOrigins: ["*"], // Tests run with AUTH_DISABLED=true, so all origins are allowed
		blockedPatterns: [/<script/i, /javascript:/i, /onload=/i, /DROP TABLE/i, /UNION SELECT/i],
	},

	// Endpoints à tester
	endpoints: {
		health: "/health",
		tables: "/api/tables",
		stats: "/api/stats",
		refresh: "/api/refresh",
		tableRecords: "/api/tables/:table",
		singleRecord: "/api/tables/:table/:id",
	},

	// Tables de test (si disponibles)
	testTables: ["Users", "Clinics", "Requests", "Content", "Countries"],
};

export default TEST_CONFIG;
