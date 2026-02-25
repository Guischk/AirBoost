/**
 * SQLite service to replace Redis
 * Uses bun:sqlite with dual-database architecture (like Redis dual-namespace)
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { loggers } from "../logger";

const logger = loggers.sqlite;

type ActiveVersion = "v1" | "v2";

interface AirtableRecord {
	id: string;
	table_name: string;
	record_id: string;
	data: string; // JSON stringified
	updated_at: string;
}

interface Attachment {
	id: string;
	table_name: string;
	record_id: string;
	field_name: string;
	original_url: string;
	local_path?: string;
	filename: string;
	size?: number;
	type?: string;
	downloaded_at?: string;
}

class SQLiteService {
	private activeDb: Database | null = null;
	private inactiveDb: Database | null = null;
	private metadataDb: Database | null = null;
	private v1Path: string;
	private v2Path: string;
	private metadataPath: string;
	private currentActive: ActiveVersion = "v1";

	// Expose databases for mapping sync (read-only access to internals)
	public get v1Db(): Database | null {
		return this.currentActive === "v1" ? this.activeDb : this.inactiveDb;
	}

	public get v2Db(): Database | null {
		return this.currentActive === "v2" ? this.activeDb : this.inactiveDb;
	}

	constructor(
		v1Path: string = process.env.SQLITE_V1_PATH || "data/airboost-v1.sqlite",
		v2Path: string = process.env.SQLITE_V2_PATH || "data/airboost-v2.sqlite",
		metadataPath: string = process.env.SQLITE_METADATA_PATH || "data/metadata.sqlite",
	) {
		this.v1Path = v1Path;
		this.v2Path = v2Path;
		this.metadataPath = metadataPath;
	}

	/**
	 * Initialize databases (v1, v2 and metadata)
	 * Idempotent: if already connected, reuses existing connections
	 */
	async connect(): Promise<void> {
		// If already connected, reuse existing connections
		if (this.activeDb && this.inactiveDb && this.metadataDb) {
			return;
		}

		try {
			// Create data folder if it doesn't exist
			const dbDir = this.v1Path.split("/").slice(0, -1).join("/");
			if (dbDir) {
				await Bun.write(join(dbDir, ".gitkeep"), "");
			}

			// Initialize metadata database (keep it open)
			this.metadataDb = new Database(this.metadataPath);
			this.setupPragmas(this.metadataDb);
			await this.initializeMetadataSchema(this.metadataDb);

			// Retrieve active version from metadata
			this.currentActive = await this.loadActiveVersionFromMetadata(this.metadataDb);

			// Initialize both databases
			const v1Db = new Database(this.v1Path);
			const v2Db = new Database(this.v2Path);

			this.setupPragmas(v1Db);
			this.setupPragmas(v2Db);

			await this.initializeDataSchema(v1Db);
			await this.initializeDataSchema(v2Db);

			// Define which database is active/inactive
			if (this.currentActive === "v1") {
				this.activeDb = v1Db;
				this.inactiveDb = v2Db;
			} else {
				this.activeDb = v2Db;
				this.inactiveDb = v1Db;
			}

			// Migrate webhook_config from data databases to metadata if needed
			await this.migrateWebhookConfigToMetadata();

			logger.success(`SQLite connected - Active: ${this.currentActive}`);
			logger.info(`Databases: ${this.v1Path}, ${this.v2Path}`);
		} catch (error) {
			logger.error("SQLite connection error", error);
			throw error;
		}
	}

	/**
	 * Check if database is connected
	 */
	isConnected(): boolean {
		return this.activeDb !== null;
	}

	/**
	 * Configure pragmas to optimize performance
	 */
	private setupPragmas(db: Database): void {
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA synchronous = NORMAL");
		db.run("PRAGMA cache_size = 1000");
		db.run("PRAGMA temp_store = memory");
	}

	/**
	 * Initialize metadata schema
	 */
	private async initializeMetadataSchema(db: Database): Promise<void> {
		// Table to store which version is active
		db.run(`
      CREATE TABLE IF NOT EXISTS active_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version TEXT NOT NULL DEFAULT 'v1',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

		// Insert default version if it doesn't exist
		db.run(`
      INSERT OR IGNORE INTO active_version (id, version) VALUES (1, 'v1')
    `);

		// Table for webhook configuration (persistent across data refreshes)
		// Stores Airtable's macSecretBase64 for HMAC validation
		db.run(`
      CREATE TABLE IF NOT EXISTS webhook_config (
        id TEXT PRIMARY KEY DEFAULT 'default',
        webhook_id TEXT NOT NULL,
        mac_secret_base64 TEXT NOT NULL,
        notification_url TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

		// Table for webhook tracking/idempotency (persistent across data refreshes)
		// Must be in metadata to survive database swaps during full refresh
		db.run(`
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        webhook_id TEXT PRIMARY KEY,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        refresh_type TEXT NOT NULL,
        stats TEXT,
        expires_at DATETIME NOT NULL
      )
    `);

		db.run(`
      CREATE INDEX IF NOT EXISTS idx_processed_webhooks_expires 
      ON processed_webhooks(expires_at)
    `);

		// Table for base configuration (to detect base changes)
		db.run(`
      CREATE TABLE IF NOT EXISTS base_config (
        id TEXT PRIMARY KEY DEFAULT 'current',
        base_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

		// Table for metadata mappings (table ID to names)
		// Stored in metadata DB so it survives v1/v2 version flips
		db.run(`
      CREATE TABLE IF NOT EXISTS metadata_mappings (
        table_id TEXT PRIMARY KEY,
        table_name_original TEXT NOT NULL,
        table_name_normalized TEXT NOT NULL,
        primary_field_id TEXT NOT NULL,
        fields_mapping TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(table_name_original),
        UNIQUE(table_name_normalized)
      )
    `);

		db.run(
			`CREATE INDEX IF NOT EXISTS idx_mm_table_name_original ON metadata_mappings(table_name_original)`,
		);
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_mm_table_name_normalized ON metadata_mappings(table_name_normalized)`,
		);
	}

	/**
	 * Initialize data schema (airtable_records + attachments)
	 */
	private async initializeDataSchema(db: Database): Promise<void> {
		// Centralized table for all Airtable records
		db.run(`
      CREATE TABLE IF NOT EXISTS airtable_records (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

		// Index to optimize queries
		db.run(`CREATE INDEX IF NOT EXISTS idx_table_name ON airtable_records(table_name)`);
		db.run(`CREATE INDEX IF NOT EXISTS idx_record_id ON airtable_records(record_id)`);

		// Table for attachments
		db.run(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        original_url TEXT NOT NULL,
        local_path TEXT,
        filename TEXT NOT NULL,
        size INTEGER,
        type TEXT,
        downloaded_at DATETIME
      )
    `);

		// Index for attachments
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_attachments_record ON attachments(table_name, record_id)`,
		);
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_attachments_pending ON attachments(local_path) WHERE local_path IS NULL`,
		);
		db.run(`CREATE INDEX IF NOT EXISTS idx_attachments_url ON attachments(original_url)`);

		// Table for locks (in each database to avoid conflicts)
		db.run(`
		  CREATE TABLE IF NOT EXISTS locks (
		    name TEXT PRIMARY KEY,
		    lock_id TEXT NOT NULL,
		    expires_at DATETIME NOT NULL
		  )
		`);

		logger.success("Data schema initialized");
	}

	/**
	 * Load active version from metadata
	 */
	private async loadActiveVersionFromMetadata(metadataDb: Database): Promise<ActiveVersion> {
		const result = metadataDb.prepare(`SELECT version FROM active_version WHERE id = 1`).get() as
			| { version: string }
			| undefined;

		return (result?.version as ActiveVersion) || "v1";
	}

	/**
	 * Check connection health
	 */
	async healthCheck(): Promise<boolean> {
		try {
			if (!this.activeDb || !this.inactiveDb) return false;
			this.activeDb.query("SELECT 1").get();
			this.inactiveDb.query("SELECT 1").get();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Store a record in the inactive database (during refresh)
	 */
	async setRecord(
		tableNorm: string,
		recordId: string,
		data: any,
		useInactive = false,
	): Promise<void> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		const id = `${tableNorm}:${recordId}`;
		const dataStr = JSON.stringify(data);

		// Extract attachments BEFORE the transaction (async work must be outside sync transaction)
		const { extractAttachments } = await import("./schema-generator");
		const attachments = extractAttachments(recordId, data);

		// Resolve existing download info BEFORE the transaction
		type ExistingInfo = { local_path: string; downloaded_at: string };
		const resolvedAttachments: Array<{
			attachment: ReturnType<typeof extractAttachments>[number];
			localPath: string | null;
			downloadedAt: string | null;
		}> = [];

		if (attachments.length > 0) {
			const existingStmt = db.prepare(`
        SELECT local_path, downloaded_at FROM attachments
        WHERE original_url = ? AND local_path IS NOT NULL AND downloaded_at IS NOT NULL
        LIMIT 1
      `);

			for (const attachment of attachments) {
				const existing = existingStmt.get(attachment.original_url) as ExistingInfo | undefined;
				let localPath: string | null = null;
				let downloadedAt: string | null = null;
				if (existing) {
					// Verify the file still exists (async check before transaction)
					if (await Bun.file(existing.local_path).exists()) {
						localPath = existing.local_path;
						downloadedAt = existing.downloaded_at;
					}
				}
				resolvedAttachments.push({ attachment, localPath, downloadedAt });
			}
		}

		// All async work is done — now run the synchronous transaction
		this.transactionOn(db, () => {
			if (!db) return;

			// Insert/update main record
			db.prepare(
				`
        INSERT OR REPLACE INTO airtable_records (id, table_name, record_id, data, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
			).run(id, tableNorm, recordId, dataStr);

			if (resolvedAttachments.length > 0) {
				// Delete old attachments for this record
				db.prepare(
					`
          DELETE FROM attachments WHERE table_name = ? AND record_id = ?
        `,
				).run(tableNorm, recordId);

				const insertStmt = db.prepare(`
          INSERT OR REPLACE INTO attachments
          (id, table_name, record_id, field_name, original_url, filename, size, type, local_path, downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

				for (const { attachment, localPath, downloadedAt } of resolvedAttachments) {
					insertStmt.run(
						attachment.id,
						tableNorm,
						attachment.record_id,
						attachment.field_name,
						attachment.original_url,
						attachment.filename,
						attachment.size,
						attachment.type,
						localPath,
						downloadedAt,
					);
				}
			}
		});
	}

	/**
	 * Set multiple records in batch for better performance
	 */
	async setRecordsBatch(
		tableNorm: string,
		records: ReadonlyArray<{ id: string; fields: any }>,
		useInactive = false,
	): Promise<void> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		// Log which database we're writing to
		const dbPath = useInactive
			? this.currentActive === "v1"
				? this.v2Path
				: this.v1Path
			: this.currentActive === "v1"
				? this.v1Path
				: this.v2Path;
		logger.info("setRecordsBatch called", {
			tableNorm,
			recordCount: records.length,
			useInactive,
			currentActive: this.currentActive,
			targetDb: dbPath,
		});

		// Import extractAttachments BEFORE the transaction (dynamic import is async)
		const { extractAttachments } = await import("./schema-generator");

		// Resolve all attachment info BEFORE the transaction (file-system checks are async)
		type ExistingInfo = { local_path: string; downloaded_at: string };
		const existingAttachmentStmt = db.prepare(`
      SELECT local_path, downloaded_at FROM attachments
      WHERE original_url = ? AND local_path IS NOT NULL AND downloaded_at IS NOT NULL
      LIMIT 1
    `);

		type ResolvedRecord = {
			compositeId: string;
			recordId: string;
			dataStr: string;
			resolvedAttachments: Array<{
				attachment: ReturnType<typeof extractAttachments>[number];
				localPath: string | null;
				downloadedAt: string | null;
			}>;
		};

		const resolvedRecords: ResolvedRecord[] = [];

		for (const record of records) {
			const compositeId = `${tableNorm}:${record.id}`;
			const dataStr = JSON.stringify(record.fields);

			logger.debug("Inserting record into SQLite", {
				id: compositeId,
				tableNorm,
				recordId: record.id,
				dataLength: dataStr.length,
				dataSample: dataStr.substring(0, 200),
			});

			const attachments = extractAttachments(record.id, record.fields);
			const resolvedAttachments: ResolvedRecord["resolvedAttachments"] = [];

			for (const attachment of attachments) {
				const existing = existingAttachmentStmt.get(attachment.original_url) as
					| ExistingInfo
					| undefined;
				let localPath: string | null = null;
				let downloadedAt: string | null = null;
				if (existing && (await Bun.file(existing.local_path).exists())) {
					localPath = existing.local_path;
					downloadedAt = existing.downloaded_at;
				}
				resolvedAttachments.push({ attachment, localPath, downloadedAt });
			}

			resolvedRecords.push({ compositeId, recordId: record.id, dataStr, resolvedAttachments });
		}

		// All async work is done — now run the synchronous transaction
		const recordStmt = db.prepare(`
      INSERT OR REPLACE INTO airtable_records (id, table_name, record_id, data, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

		const deleteAttachmentStmt = db.prepare(`
      DELETE FROM attachments WHERE table_name = ? AND record_id = ?
    `);

		const insertAttachmentStmt = db.prepare(`
      INSERT OR REPLACE INTO attachments
      (id, table_name, record_id, field_name, original_url, filename, size, type, local_path, downloaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

		this.transactionOn(db, () => {
			for (const { compositeId, recordId, dataStr, resolvedAttachments } of resolvedRecords) {
				recordStmt.run(compositeId, tableNorm, recordId, dataStr);

				if (resolvedAttachments.length > 0) {
					deleteAttachmentStmt.run(tableNorm, recordId);

					for (const { attachment, localPath, downloadedAt } of resolvedAttachments) {
						insertAttachmentStmt.run(
							attachment.id,
							tableNorm,
							attachment.record_id,
							attachment.field_name,
							attachment.original_url,
							attachment.filename,
							attachment.size,
							attachment.type,
							localPath,
							downloadedAt,
						);
					}
				}
			}
		});
	}

	/**
	 * Check if a table exists
	 */
	async tableExists(tableNorm: string, useInactive = false): Promise<boolean> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		const stmt = db.prepare(`
      SELECT 1 FROM airtable_records
      WHERE table_name = ?
      LIMIT 1
    `);

		const result = stmt.get(tableNorm);
		return !!result;
	}

	/**
	 * Retrieve records with pagination and filtering
	 */
	async getRecords(
		tableNorm: string,
		options: {
			limit?: number;
			offset?: number;
			modifiedAfter?: string;
			filter?: string;
			useInactive?: boolean;
		} = {},
	): Promise<{ records: any[]; total: number }> {
		const { limit = 100, offset = 0, modifiedAfter, filter, useInactive = false } = options;

		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		let whereClause = "WHERE table_name = ?";
		const params: any[] = [tableNorm];

		if (modifiedAfter) {
			whereClause += " AND updated_at > ?";
			params.push(modifiedAfter);
		}

		// Simple filtering logic (can be expanded)
		// Note: For complex filtering, we rely on application logic or expanded SQL columns
		if (filter) {
			// This is a basic example, in production you might want structured JSON queries
			// SQLite JSON1 extension allows querying inside JSON
			// WHERE json_extract(data, '$.field') = 'value'
		}

		// Count total matching records
		const countQuery = `SELECT COUNT(*) as count FROM airtable_records ${whereClause}`;
		const countStmt = db.prepare(countQuery);
		const total = (countStmt.get(...params) as { count: number }).count;

		// Fetch records
		const query = `
      SELECT data, updated_at FROM airtable_records
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `;

		const stmt = db.prepare(query);
		const rows = stmt.all(...params, limit, offset) as {
			data: string;
			updated_at: string;
		}[];

		const records = rows.map((row) => {
			const data = JSON.parse(row.data);
			// Inject metadata if needed
			// data._updated_at = row.updated_at;
			return data;
		});

		return { records, total };
	}

	/**
	 * Retrieve a specific record from the active database
	 */
	async getRecord(tableNorm: string, recordId: string, useInactive = false): Promise<any | null> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		// Log which database we're reading from
		const dbPath = useInactive
			? this.currentActive === "v1"
				? this.v2Path
				: this.v1Path
			: this.currentActive === "v1"
				? this.v1Path
				: this.v2Path;
		logger.info("getRecord called", {
			tableNorm,
			recordId,
			useInactive,
			currentActive: this.currentActive,
			sourceDb: dbPath,
		});

		const id = `${tableNorm}:${recordId}`;

		const stmt = db.prepare(`
      SELECT data FROM airtable_records
      WHERE id = ?
    `);

		const result = stmt.get(id) as { data: string } | undefined;
		return result ? JSON.parse(result.data) : null;
	}

	/**
	 * Retrieve all records from a table from the active database
	 */
	async getTableRecords(
		tableNorm: string,
		useInactive = false,
		limit?: number,
		offset?: number,
	): Promise<any[]> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		let query = `
      SELECT data FROM airtable_records
      WHERE table_name = ?
      ORDER BY record_id
    `;

		const params: any[] = [tableNorm];

		if (limit) {
			query += ` LIMIT ?`;
			params.push(limit);

			if (offset) {
				query += ` OFFSET ?`;
				params.push(offset);
			}
		}

		const stmt = db.prepare(query);
		const results = stmt.all(...params) as { data: string }[];

		return results.map((row) => JSON.parse(row.data));
	}

	/**
	 * Count records in a table
	 */
	async countTableRecords(tableNorm: string, useInactive = false): Promise<number> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM airtable_records
      WHERE table_name = ?
    `);

		const result = stmt.get(tableNorm) as { count: number };
		return result.count;
	}

	/**
	 * Retrieve list of available tables
	 */
	async getTables(useInactive = false): Promise<string[]> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		const stmt = db.prepare(`
      SELECT DISTINCT table_name FROM airtable_records
      ORDER BY table_name
    `);

		const results = stmt.all() as { table_name: string }[];
		return results.map((row) => row.table_name);
	}

	/**
	 * Completely clear the inactive database (before refresh)
	 */
	async clearInactiveDatabase(): Promise<void> {
		if (!this.inactiveDb) throw new Error("Inactive database not connected");

		this.transactionOn(this.inactiveDb, () => {
			if (!this.inactiveDb) return;
			this.inactiveDb.run(`DELETE FROM airtable_records`);
			this.inactiveDb.run(`DELETE FROM attachments`);
			this.inactiveDb.run(`DELETE FROM locks`);
		});

		logger.info("Inactive database cleared");
	}

	/**
	 * Get current active version
	 */
	async getActiveVersion(): Promise<ActiveVersion> {
		return this.currentActive;
	}

	/**
	 * Set active version in metadata
	 */
	private setActiveVersionInMetadata(version: ActiveVersion): void {
		if (!this.metadataDb) throw new Error("Metadata database not connected");
		this.metadataDb
			.prepare(`UPDATE active_version SET version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
			.run(version);
		logger.info(`Active version switched to: ${version}`);
	}

	/**
	 * Get inactive version
	 */
	async getInactiveVersion(): Promise<ActiveVersion> {
		return this.currentActive === "v1" ? "v2" : "v1";
	}

	/**
	 * Atomically switch to inactive version (equivalent to flipActiveNS)
	 */
	async flipActiveVersion(): Promise<ActiveVersion> {
		const newActive = await this.getInactiveVersion();

		// Write to metadata
		this.setActiveVersionInMetadata(newActive);

		// Switch memory pointers
		this.currentActive = newActive;
		const temp = this.activeDb;
		this.activeDb = this.inactiveDb;
		this.inactiveDb = temp;

		logger.success(`Atomic switch completed to ${newActive}`);
		return newActive;
	}

	/**
	 * Store an attachment with local path
	 */
	async setAttachmentLocalPath(id: string, localPath: string): Promise<void> {
		if (!this.activeDb) throw new Error("Database not connected");

		const stmt = this.activeDb.prepare(`
      UPDATE attachments
      SET local_path = ?, downloaded_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

		stmt.run(localPath, id);
	}

	/**
	 * Retrieve an attachment from the active database
	 */
	async getAttachment(id: string): Promise<Attachment | null> {
		if (!this.activeDb) throw new Error("Database not connected");

		const stmt = this.activeDb.prepare(`SELECT * FROM attachments WHERE id = ?`);
		return stmt.get(id) as Attachment | null;
	}

	/**
	 * Retrieve all attachments for a table
	 */
	async getTableAttachments(tableName: string, useInactive = false): Promise<Attachment[]> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		const stmt = db.prepare(`
      SELECT * FROM attachments
      WHERE table_name = ?
      ORDER BY record_id, field_name, original_url
    `);

		return stmt.all(tableName) as Attachment[];
	}

	/**
	 * Retrieve all attachments for a record
	 */
	async getRecordAttachments(
		tableName: string,
		recordId: string,
		useInactive = false,
	): Promise<Attachment[]> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		const stmt = db.prepare(`
      SELECT * FROM attachments
      WHERE table_name = ? AND record_id = ?
      ORDER BY field_name, original_url
    `);

		return stmt.all(tableName, recordId) as Attachment[];
	}

	/**
	 * Retrieve all attachments for a specific field
	 */
	async getFieldAttachments(
		tableName: string,
		recordId: string,
		fieldName: string,
		useInactive = false,
	): Promise<Attachment[]> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		const stmt = db.prepare(`
      SELECT * FROM attachments
      WHERE table_name = ? AND record_id = ? AND field_name = ?
      ORDER BY original_url
    `);

		return stmt.all(tableName, recordId, fieldName) as Attachment[];
	}

	/**
	 * Retrieve all non-downloaded attachments
	 */
	async getPendingAttachments(useInactive = false): Promise<Attachment[]> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		const stmt = db.prepare(`
      SELECT * FROM attachments
      WHERE (local_path IS NULL OR local_path = '')
      ORDER BY table_name, record_id
    `);

		return stmt.all() as Attachment[];
	}

	/**
	 * Mark an attachment as downloaded
	 */
	async markAttachmentDownloaded(id: string, localPath: string, size?: number): Promise<void> {
		// Can be called on inactive (during refresh) or active
		const db = this.inactiveDb || this.activeDb;
		if (!db) throw new Error("Database not connected");

		// Try both databases to be safe? Or just use the one where it exists?
		// Better to update where the record exists.
		const checkActive = this.activeDb?.prepare("SELECT 1 FROM attachments WHERE id = ?").get(id);
		const checkInactive = this.inactiveDb
			?.prepare("SELECT 1 FROM attachments WHERE id = ?")
			.get(id);

		const dbsToUpdate = [];
		if (checkActive && this.activeDb) dbsToUpdate.push(this.activeDb);
		if (checkInactive && this.inactiveDb) dbsToUpdate.push(this.inactiveDb);

		if (dbsToUpdate.length === 0) {
			logger.warn(`Attachment ${id} not found in any connected database`);
			return;
		}

		for (const targetDb of dbsToUpdate) {
			const stmt = targetDb.prepare(`
        UPDATE attachments
        SET local_path = ?, downloaded_at = CURRENT_TIMESTAMP, size = COALESCE(?, size)
        WHERE id = ?
      `);
			stmt.run(localPath, size ?? null, id);
		}
	}

	/**
	 * Global statistics of the active database
	 */
	async getStats(): Promise<{
		totalRecords: number;
		totalTables: number;
		dbSize: string;
	}> {
		if (!this.activeDb) throw new Error("Database not connected");

		const recordsStmt = this.activeDb.prepare(`
      SELECT COUNT(*) as count FROM airtable_records
    `);
		const totalRecords = (recordsStmt.get() as { count: number }).count;

		const tablesStmt = this.activeDb.prepare(`
      SELECT COUNT(DISTINCT table_name) as count FROM airtable_records
    `);
		const totalTables = (tablesStmt.get() as { count: number }).count;

		// Size of both DB files
		const activeFile = Bun.file(this.currentActive === "v1" ? this.v1Path : this.v2Path);
		const inactiveFile = Bun.file(this.currentActive === "v1" ? this.v2Path : this.v1Path);
		const activeSize = await activeFile.size;
		const inactiveSize = await inactiveFile.size;
		const totalSize = activeSize + inactiveSize;
		const dbSize = `${(totalSize / 1024 / 1024).toFixed(2)} MB`;

		return { totalRecords, totalTables, dbSize };
	}

	/**
	 * Transaction on the active database
	 */
	transaction<T>(fn: () => T): T {
		if (!this.activeDb) throw new Error("Database not connected");
		const txn = this.activeDb.transaction(fn);
		return txn();
	}

	/**
	 * Transaction on a specific database
	 */
	transactionOn<T>(db: Database, fn: () => T): T {
		const txn = db.transaction(fn);
		return txn();
	}

	/**
	 * Supprimer un record (pour webhook incremental)
	 */
	async deleteRecord(tableNorm: string, recordId: string, useInactive = false): Promise<void> {
		const db = useInactive ? this.inactiveDb : this.activeDb;
		if (!db) throw new Error("Database not connected");

		const id = `${tableNorm}:${recordId}`;

		this.transactionOn(db, () => {
			if (!db) return;

			// Supprimer le record principal
			db.prepare(`DELETE FROM airtable_records WHERE id = ?`).run(id);

			// Supprimer les attachments associés
			db.prepare(`DELETE FROM attachments WHERE table_name = ? AND record_id = ?`).run(
				tableNorm,
				recordId,
			);
		});

		logger.debug(`Record deleted: ${id}`);
	}

	/**
	 * Vérifier si un webhook a déjà été traité
	 * Uses metadataDb for persistence across database swaps
	 */
	async isWebhookProcessed(webhookId: string): Promise<boolean> {
		if (!this.metadataDb) throw new Error("Metadata database not connected");

		const stmt = this.metadataDb.prepare(`
      SELECT 1 FROM processed_webhooks 
      WHERE webhook_id = ? AND expires_at > datetime('now')
    `);

		const result = stmt.get(webhookId);
		return !!result;
	}

	/**
	 * Marquer un webhook comme traité
	 * Uses metadataDb for persistence across database swaps
	 */
	async markWebhookProcessed(
		webhookId: string,
		refreshType: "incremental" | "full",
		stats: any,
	): Promise<void> {
		if (!this.metadataDb) throw new Error("Metadata database not connected");

		const { config } = await import("../../config");
		const expiresAt = new Date(Date.now() + config.webhookIdempotencyTTL * 1000);

		const stmt = this.metadataDb.prepare(`
      INSERT OR REPLACE INTO processed_webhooks 
      (webhook_id, refresh_type, stats, expires_at)
      VALUES (?, ?, ?, ?)
    `);

		stmt.run(webhookId, refreshType, JSON.stringify(stats), expiresAt.toISOString());
	}

	/**
	 * Cleanup des webhooks expirés (à appeler périodiquement)
	 * Uses metadataDb for persistence across database swaps
	 */
	async cleanupExpiredWebhooks(): Promise<number> {
		if (!this.metadataDb) throw new Error("Metadata database not connected");

		const stmt = this.metadataDb.prepare(`
      DELETE FROM processed_webhooks 
      WHERE expires_at <= datetime('now')
    `);

		const result = stmt.run();
		return result.changes;
	}

	/**
	 * Stocker la configuration du webhook Airtable (in metadata database for persistence)
	 */
	async storeWebhookConfig(
		webhookId: string,
		macSecretBase64: string,
		notificationUrl: string,
	): Promise<void> {
		if (!this.metadataDb) throw new Error("Metadata database not connected");

		const stmt = this.metadataDb.prepare(`
      INSERT OR REPLACE INTO webhook_config 
      (id, webhook_id, mac_secret_base64, notification_url, updated_at)
      VALUES ('default', ?, ?, ?, datetime('now'))
    `);

		stmt.run(webhookId, macSecretBase64, notificationUrl);
		logger.info(`Webhook config stored: ${webhookId}`);
	}

	/**
	 * Récupérer la configuration du webhook Airtable (from metadata database)
	 */
	async getWebhookConfig(): Promise<{
		webhookId: string;
		macSecretBase64: string;
		notificationUrl: string;
	} | null> {
		if (!this.metadataDb) throw new Error("Metadata database not connected");

		const stmt = this.metadataDb.prepare(`
      SELECT webhook_id, mac_secret_base64, notification_url 
      FROM webhook_config 
      WHERE id = 'default'
    `);

		const result = stmt.get() as
			| {
					webhook_id: string;
					mac_secret_base64: string;
					notification_url: string;
			  }
			| undefined;

		if (!result) return null;

		return {
			webhookId: result.webhook_id,
			macSecretBase64: result.mac_secret_base64,
			notificationUrl: result.notification_url,
		};
	}

	/**
	 * Supprimer la configuration du webhook (pour resync)
	 */
	async clearWebhookConfig(): Promise<void> {
		if (!this.metadataDb) throw new Error("Metadata database not connected");

		const stmt = this.metadataDb.prepare(`
      DELETE FROM webhook_config WHERE id = 'default'
    `);
		stmt.run();
		logger.info("Webhook config cleared from SQLite");
	}

	/**
	 * Migrate webhook_config from data databases (v1/v2) to metadata database
	 * This is a one-time migration for existing installations
	 */
	private async migrateWebhookConfigToMetadata(): Promise<void> {
		if (!this.metadataDb || !this.activeDb) return;

		// Check if metadata already has a webhook config
		const existingConfig = this.metadataDb
			.prepare("SELECT 1 FROM webhook_config WHERE id = 'default'")
			.get();

		if (existingConfig) {
			logger.debug("Webhook config already in metadata, skipping migration");
			return;
		}

		// Check if there's a legacy webhook_config table in active database
		const tableExists = this.activeDb
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_config'")
			.get();

		if (!tableExists) {
			logger.debug("No legacy webhook_config table found, skipping migration");
			return;
		}

		// Try to migrate from active database
		const legacyConfig = this.activeDb
			.prepare(
				`
        SELECT webhook_id, mac_secret_base64, notification_url 
        FROM webhook_config 
        WHERE id = 'default'
      `,
			)
			.get() as
			| {
					webhook_id: string;
					mac_secret_base64: string;
					notification_url: string;
			  }
			| undefined;

		if (legacyConfig) {
			// Migrate to metadata
			const stmt = this.metadataDb.prepare(`
        INSERT OR REPLACE INTO webhook_config 
        (id, webhook_id, mac_secret_base64, notification_url, updated_at)
        VALUES ('default', ?, ?, ?, datetime('now'))
      `);
			stmt.run(
				legacyConfig.webhook_id,
				legacyConfig.mac_secret_base64,
				legacyConfig.notification_url,
			);

			logger.success(`Migrated webhook config to metadata: ${legacyConfig.webhook_id}`);
		}
	}

	// ========================================
	// TABLE MAPPING METHODS
	// ========================================

	/**
	 * Upsert table mapping into metadata database.
	 * Mappings are stored in metadataDb so they survive v1/v2 version flips.
	 */
	async upsertTableMapping(mapping: {
		id: string;
		originalName: string;
		normalizedName: string;
		primaryFieldId: string;
		fields: Record<string, unknown>;
	}): Promise<void> {
		if (!this.metadataDb) throw new Error("Metadata database not connected");
		this.metadataDb
			.prepare(
				`
		  INSERT INTO metadata_mappings (
		    table_id, table_name_original, table_name_normalized,
		    primary_field_id, fields_mapping, updated_at
		  ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		  ON CONFLICT(table_id) DO UPDATE SET
		    table_name_original = excluded.table_name_original,
		    table_name_normalized = excluded.table_name_normalized,
		    primary_field_id = excluded.primary_field_id,
		    fields_mapping = excluded.fields_mapping,
		    updated_at = CURRENT_TIMESTAMP
		`,
			)
			.run(
				mapping.id,
				mapping.originalName,
				mapping.normalizedName,
				mapping.primaryFieldId,
				JSON.stringify(mapping.fields),
			);
	}

	/**
	 * Get original table name by table ID (for Airtable API calls)
	 */
	getOriginalTableNameById(tableId: string): string | null {
		if (!this.metadataDb) return null;

		const result = this.metadataDb
			.prepare(
				`
		  SELECT table_name_original 
		  FROM metadata_mappings 
		  WHERE table_id = ?
		`,
			)
			.get(tableId) as { table_name_original: string } | undefined;

		return result?.table_name_original || null;
	}

	/**
	 * Get normalized table name by table ID (for SQLite storage)
	 */
	getNormalizedTableNameById(tableId: string): string | null {
		if (!this.metadataDb) return null;

		const result = this.metadataDb
			.prepare(
				`
		  SELECT table_name_normalized 
		  FROM metadata_mappings 
		  WHERE table_id = ?
		`,
			)
			.get(tableId) as { table_name_normalized: string } | undefined;

		return result?.table_name_normalized || null;
	}

	/**
	 * Get original table name by normalized name (for write-back to Airtable)
	 */
	getOriginalTableNameByNormalized(normalizedName: string): string | null {
		if (!this.metadataDb) return null;

		const result = this.metadataDb
			.prepare(
				`
		  SELECT table_name_original 
		  FROM metadata_mappings 
		  WHERE table_name_normalized = ?
		`,
			)
			.get(normalizedName) as { table_name_original: string } | undefined;

		return result?.table_name_original || null;
	}

	/**
	 * Get table ID by normalized name
	 */
	getTableIdByNormalizedName(normalizedName: string): string | null {
		if (!this.metadataDb) return null;

		const result = this.metadataDb
			.prepare(
				`
		  SELECT table_id 
		  FROM metadata_mappings 
		  WHERE table_name_normalized = ?
		`,
			)
			.get(normalizedName) as { table_id: string } | undefined;

		return result?.table_id || null;
	}

	/**
	 * Get all table mappings (for API endpoint)
	 */
	getAllMappings(): Array<{
		id: string;
		originalName: string;
		normalizedName: string;
		primaryFieldId: string;
		fields: Record<string, unknown>;
	}> {
		if (!this.metadataDb) return [];

		const rows = this.metadataDb
			.prepare(
				`
		  SELECT table_id, table_name_original, table_name_normalized,
		         primary_field_id, fields_mapping
		  FROM metadata_mappings
		  ORDER BY table_name_original
		`,
			)
			.all() as Array<{
			table_id: string;
			table_name_original: string;
			table_name_normalized: string;
			primary_field_id: string;
			fields_mapping: string;
		}>;

		return rows.map((row) => ({
			id: row.table_id,
			originalName: row.table_name_original,
			normalizedName: row.table_name_normalized,
			primaryFieldId: row.primary_field_id,
			fields: JSON.parse(row.fields_mapping) as Record<string, unknown>,
		}));
	}

	/**
	 * Get field mapping for a specific field
	 */
	getFieldMapping(
		tableIdOrName: string,
		fieldId: string,
	): { id: string; name: string; type: string } | null {
		if (!this.metadataDb) return null;

		// Try to find by table ID first
		let result = this.metadataDb
			.prepare(
				`
		  SELECT fields_mapping 
		  FROM metadata_mappings 
		  WHERE table_id = ?
		`,
			)
			.get(tableIdOrName) as { fields_mapping: string } | undefined;

		// If not found, try by normalized name
		if (!result) {
			result = this.metadataDb
				.prepare(
					`
			  SELECT fields_mapping 
			  FROM metadata_mappings 
			  WHERE table_name_normalized = ?
			`,
				)
				.get(tableIdOrName) as { fields_mapping: string } | undefined;
		}

		if (!result) return null;

		const fields = JSON.parse(result.fields_mapping) as Record<
			string,
			{ id: string; name: string; type: string }
		>;
		return fields[fieldId] || null;
	}

	// ========================================
	// BASE CONFIGURATION METHODS
	// ========================================

	/**
	 * Get stored base ID from metadata
	 */
	getStoredBaseId(): string | null {
		if (!this.metadataDb) return null;

		const result = this.metadataDb
			.prepare("SELECT base_id FROM base_config WHERE id = 'current'")
			.get() as { base_id: string } | undefined;

		return result?.base_id || null;
	}

	/**
	 * Store base ID in metadata
	 */
	setStoredBaseId(baseId: string): void {
		if (!this.metadataDb) throw new Error("Metadata database not connected");

		const stmt = this.metadataDb.prepare(`
      INSERT OR REPLACE INTO base_config (id, base_id, updated_at)
      VALUES ('current', ?, datetime('now'))
    `);
		stmt.run(baseId);
		logger.info("Base ID stored in metadata", { baseId });
	}

	/**
	 * Clear all cached data from v1 and v2 databases (for base change)
	 */
	async clearAllCachedData(): Promise<void> {
		if (!this.activeDb || !this.inactiveDb) {
			throw new Error("Databases not connected");
		}

		// Clear both data databases
		for (const db of [this.activeDb, this.inactiveDb]) {
			this.transactionOn(db, () => {
				db.run("DELETE FROM airtable_records");
				db.run("DELETE FROM attachments");
				db.run("DELETE FROM locks");
			});
		}

		// Clear mappings from metadata DB (they will be re-synced on next startup)
		if (this.metadataDb) {
			this.metadataDb.run("DELETE FROM metadata_mappings");
		}

		logger.info("All cached data cleared from v1 and v2 databases");
	}

	/**
	 * Clear all metadata related to webhooks and processed webhooks
	 */
	async clearWebhookMetadata(): Promise<void> {
		if (!this.metadataDb) throw new Error("Metadata database not connected");

		this.metadataDb.run("DELETE FROM webhook_config");
		this.metadataDb.run("DELETE FROM processed_webhooks");

		logger.info("Webhook metadata cleared");
	}

	/**
	 * Close all connections
	 */
	async close(): Promise<void> {
		if (this.activeDb) {
			this.activeDb.close();
			this.activeDb = null;
		}
		if (this.inactiveDb) {
			this.inactiveDb.close();
			this.inactiveDb = null;
		}
		if (this.metadataDb) {
			this.metadataDb.close();
			this.metadataDb = null;
		}
		logger.success("SQLite connections closed");
	}
}

// Instance singleton
export const sqliteService = new SQLiteService();
export { SQLiteService };
export type { AirtableRecord, Attachment, ActiveVersion };
