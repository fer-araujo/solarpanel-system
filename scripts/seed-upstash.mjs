// Uploads data/cfe-readings.json to Upstash so the deployed app starts with
// the bill history. Reads UPSTASH_REDIS_REST_URL/TOKEN from .env or the shell.
//
//   node scripts/seed-upstash.mjs          # refuses to overwrite existing data
//   node scripts/seed-upstash.mjs --force  # replaces what is in Upstash

import { readFileSync } from "node:fs";
import { Redis } from "@upstash/redis";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on variables already in the environment.
}

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN first.");
  process.exit(1);
}

// Must match the prefix in server/storage/kv.ts and the key in KvReadingsStore.
const KEY = "solar:cfe-readings";
const file = JSON.parse(readFileSync("data/cfe-readings.json", "utf8"));
const redis = new Redis({ url, token });

if (!process.argv.includes("--force") && (await redis.exists(KEY))) {
  console.error(`${KEY} already exists. Re-run with --force to overwrite it.`);
  process.exit(1);
}

await redis.set(KEY, file);
console.log(
  `Uploaded ${file.readings?.length ?? 0} readings and ${file.history?.length ?? 0} bills to ${KEY}.`,
);
