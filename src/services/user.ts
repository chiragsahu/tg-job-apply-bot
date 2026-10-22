import { randomUUID } from "node:crypto";
import { type Collection } from "mongodb";
import { getDb } from "./db.js";
import type {
  UserDoc,
  UserSmtp,
  UserResume,
  CandidateProfile,
  UserRole,
} from "../models/User.js";

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
  firstName?: string,
): Promise<UserDoc> {
  const col = await collection();
  const now = new Date();

  await col.updateOne(
    { telegramId },
    {
      $setOnInsert: { telegramId, templates: {}, createdAt: now },
      $set: {
        updatedAt: now,
        ...(username && { username }),
        ...(firstName && { firstName }),
      },
    },
    { upsert: true },
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
  resume: UserResume,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    { $set: { resume, updatedAt: new Date() } },
  );
}

/**
 * Saves the user's SMTP configuration (password must already be encrypted).
 */
export async function updateSmtp(
  telegramId: number,
  smtp: UserSmtp,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    { $set: { smtp, updatedAt: new Date() } },
  );
}

/**
 * Saves the user's default email template/tone notes.
 */
export async function updateTemplate(
  telegramId: number,
  template: string,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    { $set: { "templates.default": template, updatedAt: new Date() } },
  );
}

/**
 * Returns true if the user has a configured and saved SMTP setup.
 */
export async function hasSmtp(telegramId: number): Promise<boolean> {
  const col = await collection();
  const user = await col.findOne(
    { telegramId, smtp: { $exists: true } },
    { projection: { _id: 1 } },
  );
  return user !== null;
}

/**
 * Removes the stored resume from the user's document.
 */
export async function deleteResume(telegramId: number): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    { $unset: { resume: "" }, $set: { updatedAt: new Date() } },
  );
}

/**
 * Removes the stored SMTP configuration from the user's document.
 * The user will need to run /setup again to send emails.
 */
export async function deleteSmtp(telegramId: number): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    { $unset: { smtp: "" }, $set: { updatedAt: new Date() } },
  );
}

/**
 * Removes the default cover letter template from the user's document.
 */
export async function deleteTemplate(telegramId: number): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    { $unset: { "templates.default": "" }, $set: { updatedAt: new Date() } },
  );
}

/**
 * Permanently deletes the user's entire document from MongoDB.
 * Irreversible. Used by /reset.
 */
export async function deleteUser(telegramId: number): Promise<void> {
  const col = await collection();
  await col.deleteOne({ telegramId });
}

// ── Candidate Profile Operations ─────────────────────────────────────────────

/**
 * Gets the candidate profile details for a user.
 */
export async function getCandidateProfile(
  telegramId: number,
): Promise<CandidateProfile | undefined> {
  const col = await collection();
  const user = await col.findOne(
    { telegramId },
    { projection: { profile: 1 } },
  );
  return user?.profile;
}

// New: Retrieve SMTP configuration for a user
export async function getSmtp(
  telegramId: number,
): Promise<UserSmtp | undefined> {
  const col = await collection();
  const user = await col.findOne({ telegramId }, { projection: { smtp: 1 } });
  return user?.smtp;
}

// New: Update a single field of the SMTP config, preserving other fields
export async function updateSmtpField(
  telegramId: number,
  field: keyof UserSmtp,
  value: any,
): Promise<void> {
  const existing = await getSmtp(telegramId);
  const updated = { ...(existing || {}), [field]: value } as UserSmtp;
  await updateSmtp(telegramId, updated);
}

// New: Update a single field of the candidate profile, preserving other fields
export async function updateCandidateProfileField(
  telegramId: number,
  field: keyof CandidateProfile,
  value: any,
): Promise<void> {
  const existing = await getCandidateProfile(telegramId);
  const updates: Partial<CandidateProfile> = {
    ...(existing || {}),
    [field]: value,
  };
  await updateCandidateProfile(telegramId, updates);
}

/**
 * Updates or merges candidate profile fields.
 */
export async function updateCandidateProfile(
  telegramId: number,
  profileUpdates: Partial<CandidateProfile>,
): Promise<void> {
  const col = await collection();
  const setObj: Record<string, unknown> = {
    updatedAt: new Date(),
    "profile.updatedAt": new Date(),
  };

  for (const [key, value] of Object.entries(profileUpdates)) {
    if (value !== undefined) {
      setObj[`profile.${key}`] = value;
    }
  }

  await col.updateOne({ telegramId }, { $set: setObj });
}

// ── Role & 1-to-1 Resume Operations ──────────────────────────────────────────

/**
 * Gets all roles configured for a user.
 */
export async function getRoles(telegramId: number): Promise<UserRole[]> {
  const col = await collection();
  const user = await col.findOne({ telegramId }, { projection: { roles: 1 } });
  return user?.roles ?? [];
}

/**
 * Gets a specific role by roleId.
 */
export async function getRole(
  telegramId: number,
  roleId: string,
): Promise<UserRole | null> {
  const col = await collection();
  const user = await col.findOne(
    { telegramId, "roles.id": roleId },
    { projection: { "roles.$": 1 } },
  );
  return user?.roles?.[0] ?? null;
}

/**
 * Adds a new role to the user's roles list with optional role-specific screening details.
 */
export async function addRole(
  telegramId: number,
  name: string,
  details?: {
    relevantExperience?: string | undefined;
    expectedCtc?: string | undefined;
    holdingOffer?: string | undefined;
  },
): Promise<UserRole> {
  const col = await collection();
  const now = new Date();
  const newRole: UserRole = {
    id: randomUUID(),
    name: name.trim(),
    ...(details?.relevantExperience !== undefined && {
      relevantExperience: details.relevantExperience,
    }),
    ...(details?.expectedCtc !== undefined && {
      expectedCtc: details.expectedCtc,
    }),
    ...(details?.holdingOffer !== undefined && {
      holdingOffer: details.holdingOffer,
    }),
    createdAt: now,
    updatedAt: now,
  };

  await col.updateOne(
    { telegramId },
    {
      $push: { roles: newRole },
      $set: { updatedAt: now },
    },
  );

  return newRole;
}

/**
 * Updates role-specific screening details (relevant exp, expected CTC, holding offer) or role name.
 */
export async function updateRoleDetails(
  telegramId: number,
  roleId: string,
  updates: {
    name?: string | undefined;
    relevantExperience?: string | undefined;
    expectedCtc?: string | undefined;
    holdingOffer?: string | undefined;
  },
): Promise<void> {
  const col = await collection();
  const now = new Date();
  const setObj: Record<string, unknown> = {
    "roles.$.updatedAt": now,
    updatedAt: now,
  };

  if (updates.name !== undefined) setObj["roles.$.name"] = updates.name;
  if (updates.relevantExperience !== undefined)
    setObj["roles.$.relevantExperience"] = updates.relevantExperience;
  if (updates.expectedCtc !== undefined)
    setObj["roles.$.expectedCtc"] = updates.expectedCtc;
  if (updates.holdingOffer !== undefined)
    setObj["roles.$.holdingOffer"] = updates.holdingOffer;

  await col.updateOne({ telegramId, "roles.id": roleId }, { $set: setObj });
}

/**
 * Deletes a role by roleId.
 */
export async function deleteRole(
  telegramId: number,
  roleId: string,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { telegramId },
    {
      $pull: { roles: { id: roleId } },
      $set: { updatedAt: new Date() },
    },
  );
}

/**
 * Attaches or replaces a resume on a specific role (1-to-1 relationship).
 */
export async function attachResumeToRole(
  telegramId: number,
  roleId: string,
  resume: UserResume,
): Promise<void> {
  const col = await collection();
  const now = new Date();
  await col.updateOne(
    { telegramId, "roles.id": roleId },
    {
      $set: {
        "roles.$.resume": resume,
        "roles.$.updatedAt": now,
        updatedAt: now,
      },
    },
  );
}

/**
 * Removes the attached resume from a specific role without deleting the role.
 */
export async function deleteRoleResume(
  telegramId: number,
  roleId: string,
): Promise<void> {
  const col = await collection();
  const now = new Date();
  await col.updateOne(
    { telegramId, "roles.id": roleId },
    {
      $unset: { "roles.$.resume": "" },
      $set: {
        "roles.$.updatedAt": now,
        updatedAt: now,
      },
    },
  );
}
