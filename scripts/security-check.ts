#!/usr/bin/env bun

/**
 * Security verification script
 * Detects potential production data leaks
 */

import { AIRTABLE_TABLE_NAMES } from "./src/lib/airtable/schema";

const DANGEROUS_PATTERNS = [
  // Keywords that could indicate business data
  /\b(users|customers|clients|orders|products|companies|employees)\b/i,
  // Specific numbers that could reveal production sizes
  /\b(37|716|142|1247)\s+(records?|enregistrements?)\b/i,
  // Hardcoded API patterns
  /\/api\/tables\/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/,
];

const FILES_TO_CHECK = [
  "README.md",
  "BENCHMARK.md",
  "SCRIPTS.md",
  "tests/api.test.ts",
  "tests/integration.test.ts",
  "tests/performance.test.ts",
  "demo.ts"
];

interface SecurityIssue {
  file: string;
  line: number;
  content: string;
  pattern: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
}

async function checkFile(filePath: string): Promise<SecurityIssue[]> {
  const issues: SecurityIssue[] = [];

  try {
    const file = Bun.file(filePath);
    const content = await file.text();
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // Check dangerous patterns
      DANGEROUS_PATTERNS.forEach((pattern, patternIndex) => {
        if (pattern.test(line)) {
          issues.push({
            file: filePath,
            line: index + 1,
            content: line.trim(),
            pattern: pattern.toString(),
            severity: patternIndex === 0 ? "HIGH" : "MEDIUM"
          });
        }
      });

      // Check references to real tables
      AIRTABLE_TABLE_NAMES.forEach(tableName => {
        if (line.includes(`"${tableName}"`) || line.includes(`'${tableName}'`) || line.includes(`\`${tableName}\``)) {
          // Exception for schema imports
          if (!line.includes('AIRTABLE_TABLE_NAMES') && !filePath.includes('schema.ts')) {
            issues.push({
              file: filePath,
              line: index + 1,
              content: line.trim(),
              pattern: `Hardcoded table name: ${tableName}`,
              severity: "HIGH"
            });
          }
        }
      });
    });

  } catch (error) {
    console.warn(`⚠️ Could not check ${filePath}: ${error}`);
  }

  return issues;
}

async function runSecurityCheck(): Promise<void> {
  console.log("🔒 Security Check - Airboost");
  console.log("===================================");

  const allIssues: SecurityIssue[] = [];

  // Check each file
  for (const filePath of FILES_TO_CHECK) {
    console.log(`🔍 Checking ${filePath}...`);
    const issues = await checkFile(filePath);
    allIssues.push(...issues);
  }

  // Display results
  console.log("\n📊 Security Check Results");
  console.log("========================");

  if (allIssues.length === 0) {
    console.log("✅ No security issues found!");
    console.log("🛡️ All production data appears to be properly protected.");
    return;
  }

  // Group by severity
  const highIssues = allIssues.filter(i => i.severity === "HIGH");
  const mediumIssues = allIssues.filter(i => i.severity === "MEDIUM");
  const lowIssues = allIssues.filter(i => i.severity === "LOW");

  console.log(`❌ Found ${allIssues.length} potential security issues:`);
  console.log(`   🔴 High: ${highIssues.length}`);
  console.log(`   🟡 Medium: ${mediumIssues.length}`);
  console.log(`   🟢 Low: ${lowIssues.length}\n`);

  // Display critical issues
  if (highIssues.length > 0) {
    console.log("🔴 HIGH SEVERITY ISSUES:");
    highIssues.forEach(issue => {
      console.log(`   📁 ${issue.file}:${issue.line}`);
      console.log(`   📝 ${issue.content}`);
      console.log(`   🎯 ${issue.pattern}\n`);
    });
  }

  // Display medium issues
  if (mediumIssues.length > 0) {
    console.log("🟡 MEDIUM SEVERITY ISSUES:");
    mediumIssues.forEach(issue => {
      console.log(`   📁 ${issue.file}:${issue.line}`);
      console.log(`   📝 ${issue.content}`);
      console.log(`   🎯 ${issue.pattern}\n`);
    });
  }

  // Recommendations
  console.log("🛠️ RECOMMENDATIONS:");
  console.log("   1. Replace hardcoded table names with dynamic references");
  console.log("   2. Use generic examples (Small Table, Medium Table, etc.)");
  console.log("   3. Remove specific record counts from documentation");
  console.log("   4. Use AIRTABLE_TABLE_NAMES for dynamic table selection");

  console.log("\n📖 See SECURITY.md for detailed guidelines");

  // Exit with error code if critical issues
  if (highIssues.length > 0) {
    process.exit(1);
  }
}

// Execute if called directly
if (import.meta.main) {
  await runSecurityCheck();
}

export { runSecurityCheck };