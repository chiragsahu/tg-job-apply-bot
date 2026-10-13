import { type Collection } from "mongodb";
import { getDb } from "./db.js";
import type { UserDoc, UserSmtp, UserResume } from "../models/User.js";

function collection(): Promise<Collection<UserDoc>> {
  return getDb().then((db) => db.collection<UserDoc>("users"));
}

/**
 * Upserts a user document on every bot interaction.
 * Creates the document if it doesn't exist yet.
 */
export async function getOrCreateUser(
  telegramId: number,
  username?: string,
  firstName?: string
): Promise<UserDoc> {
  const col = await collection();
  const now = new Date();

  await col.updateOne(
    { telegramId },
    {
      $setOnInsert: { telegramId, templates: {}, createdAt: now },
      $set: { updatedAt: now, ...(username && { username }), ...(firstName && { firstName }) },
    },
    { upsert: true }
  );

  return col.findOne({ telegramId }) as Promise<UserDoc>;
}

/**
 * Fetches a user by their Telegram ID.
 */
export async function getUser(telegramId: number): Promise<UserDoc | null> {
  const col = await collection();
  return col.findOne({ telegramId });
}

/**
 * Saves or replaces the user's resume metadata (file_id + cached text).
 */
export async function updateResume(
  telegramId: number,
  resume: UserResume
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    { $set: { resume, updatedAt: new Date() } }
  );
}

/**
 * Saves the user's SMTP configuration (password must already be encrypted).
 */
export async function updateSmtp(
  telegramId: number,
  smtp: UserSmtp
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    { $set: { smtp, updatedAt: new Date() } }
  );
}

/**
 * Saves the user's default email template/tone notes.
 */
export async function updateTemplate(
  telegramId: number,
  template: string
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    { $set: { "templates.default": template, updatedAt: new Date() } }
  );
}

/**
 * Returns true if the user has a configured and saved SMTP setup.
 */
export async function hasSmtp(telegramId: number): Promise<boolean> {
  const col = await collection();
  const user = await col.findOne(
    { telegramId, smtp: { $exists: true } },
    { projection: { _id: 1 } }
  );
  return user !== null;
}
