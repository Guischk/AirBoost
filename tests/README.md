# Airboost Test Suite

Comprehensive test suite ensuring quality, security, and performance.

## Quick Start

```bash
# Run all tests
bun test

# Run with watch mode
bun test --watch

# Run specific test file
bun test tests/api.test.ts
```

## Test Categories

### API Tests (`api.test.ts`)

Functional tests for all API endpoints:

- Health check endpoint
- Authentication (valid/invalid tokens)
- Tables listing and querying
- Records retrieval
- Stats endpoint
- Manual refresh
- Error handling

### Integration Tests (`integration.test.ts`)

End-to-end workflow tests:

- Complete data flow (refresh → cache → serve)
- Cross-endpoint data consistency
- Pagination handling
- Field filtering

### Performance Tests (`performance.test.ts`)

Benchmark and load tests:

- Response time targets
- Concurrent request handling
- Throughput measurements
- Memory stability

### Security Tests (`security.test.ts`)

Vulnerability testing:

- SQL injection prevention
- Authentication bypass attempts
- Input validation
- Rate limiting behavior

## Test Configuration

Tests run against a separate server instance to avoid conflicts with development:

```typescript
// tests/test-config.ts
export const TEST_PORT = 3001;
export const TEST_BASE_URL = `http://localhost:${TEST_PORT}`;
```

### Environment Variables

```bash
# For testing
BEARER_TOKEN=test-token
PORT=3001
ENABLE_ATTACHMENT_DOWNLOAD=false  # Faster tests
```

## Writing Tests

### Test Structure

```typescript
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { TEST_BASE_URL, startTestServer, stopTestServer } from "./test-config";

describe("Feature Name", () => {
	beforeAll(async () => {
		await startTestServer();
	});

	afterAll(() => {
		stopTestServer();
	});

	test("should [behavior] when [condition]", async () => {
		const response = await fetch(`${TEST_BASE_URL}/api/endpoint`, {
			headers: { Authorization: `Bearer ${process.env.BEARER_TOKEN}` },
		});

		expect(response.ok).toBe(true);
		const data = await response.json();
		expect(data).toHaveProperty("expected_field");
	});
});
```

### Dynamic Table References

Never hardcode table names. Always retrieve dynamically:

```typescript
// Get available tables
const tablesResponse = await fetch(`${TEST_BASE_URL}/api/tables`, {
	headers: { Authorization: `Bearer ${token}` },
});
const { tables } = await tablesResponse.json();

// Use first table for testing
const testTable = tables[0];
const recordsResponse = await fetch(`${TEST_BASE_URL}/api/tables/${testTable}`, {
	headers: { Authorization: `Bearer ${token}` },
});
```

## Running Benchmarks

```bash
# Performance comparison
bun run benchmark

# Outputs comparison: SQLite vs Airtable API
```

## Continuous Integration

Tests run automatically on:

- Pull requests
- Pushes to main branch

```yaml
# .github/workflows/test.yml
- name: Run Tests
  run: bun test

- name: Run Benchmarks
  run: bun run benchmark
```

## Coverage

```bash
bun test --coverage
```

## Troubleshooting

### Tests Timeout

Increase timeout in test file:

```typescript
test("slow operation", async () => {
	// test code
}, 30000); // 30 second timeout
```

### Port Already in Use

```bash
# Kill process on test port
lsof -ti:3001 | xargs kill -9
```

### Flaky Tests

If tests intermittently fail:

1. Check for shared state between tests
2. Ensure proper cleanup in `afterEach`/`afterAll`
3. Add retries for network operations
