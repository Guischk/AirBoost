/**
 * Main entry point for Airboost service
 * SQLite-only caching service for Airtable data
 */

import { startServer } from "./src/server/index";

// Start the SQLite server
await startServer();