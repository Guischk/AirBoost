#!/usr/bin/env bun

/**
 * Quick demonstration of the Airboost system
 */

const API_BASE = "http://localhost:3000";
const BEARER_TOKEN = process.env.BEARER_TOKEN || "demo-token";

console.log("🎯 Airboost Demonstration");
console.log("================================");

// Connectivity test
try {
  console.log("🩺 Health check...");
  const healthResponse = await fetch(`${API_BASE}/health`);
  const health = await healthResponse.json();

  if (health.success) {
    console.log(`✅ System ${health.data.status}`);
    console.log(`   • Database: ${health.data.services.database ? "✅" : "❌"}`);
    console.log(`   • Uptime: ${Math.round(health.data.uptime)}s`);
  } else {
    console.log("❌ Health check failed");
  }

  // API test with authentication
  console.log("\n📋 Available tables...");
  const tablesResponse = await fetch(`${API_BASE}/api/tables`, {
    headers: { "Authorization": `Bearer ${BEARER_TOKEN}` }
  });

  if (tablesResponse.ok) {
    const tables = await tablesResponse.json();
    console.log(`✅ ${tables.data.tables.length} tables found`);
    console.log(`   • Namespace: ${tables.meta.namespace}`);
    tables.data.tables.slice(0, 3).forEach((table: string) => {
      console.log(`   • ${table}`);
    });
    if (tables.data.tables.length > 3) {
      console.log(`   • ... and ${tables.data.tables.length - 3} others`);
    }
  } else {
    console.log("❌ API access failed (check BEARER_TOKEN)");
  }

  // Statistics test
  console.log("\n📊 Cache statistics...");
  const statsResponse = await fetch(`${API_BASE}/api/stats`, {
    headers: { "Authorization": `Bearer ${BEARER_TOKEN}` }
  });

  if (statsResponse.ok) {
    const stats = await statsResponse.json();
    console.log(`✅ Active cache: ${stats.data.activeNamespace}`);
    console.log(`   • Total records: ${stats.data.totalRecords}`);
    console.log(`   • Tables: ${stats.data.totalTables}`);
  }

  console.log("\n🎉 Demonstration completed!");
  console.log("📖 See README.md for more information");

} catch (error) {
  console.log("❌ Error:", error);
  console.log("\n💡 Make sure that:");
  console.log("   • The server is started (bun index.ts)");
  console.log("   • Environment variables are configured");
  console.log("   • Database is accessible");
}

export {};