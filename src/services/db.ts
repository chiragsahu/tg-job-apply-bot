import { MongoClient, type Db } from "mongodb";

let db: Db | undefined;
let client: MongoClient | undefined;

/**
 * Returns a singleton MongoDB Db instance.
 * Creates indexes on first connection.
 */
export async function getDb(): Promise<Db> {
  if (db) return db;

  const uri = process.env["MONGODB_URI"];
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not set.");
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(); // DB name comes from the URI path

  // Ensure telegramId is indexed for O(1) user lookups
  await db.collection("users").createIndex({ telegramId: 1 }, { unique: true });

  console.log("✅ Connected to MongoDB");
  return db;
}

/**
 * Gracefully closes the MongoDB connection.
 * Call on process shutdown.
 */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    console.log("🔌 MongoDB connection closed");
  }
}
