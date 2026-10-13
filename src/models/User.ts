/**
 * SMTP configuration stored per-user in MongoDB.
 * Password is always stored encrypted — never in plaintext.
 */
export interface UserSmtp {
  host: string;
  port: number;
  user: string;
  encryptedPass: string; // AES-256-GCM encrypted via crypto.ts
  senderName?: string;   // Display name in From: header
}

/**
 * Resume metadata stored per-user.
 * fileId is a permanent Telegram CDN identifier.
 * text is the cached PDF-parsed content to avoid re-downloading on every /apply.
 */
export interface UserResume {
  fileId: string;
  fileName: string;
  text: string;       // Cached parsed PDF text
  uploadedAt: Date;
}

/**
 * Top-level MongoDB user document.
 * Primary key for lookup is telegramId (indexed unique).
 */
export interface UserDoc {
  telegramId: number;
  username?: string;
  firstName?: string;
  resume?: UserResume;
  smtp?: UserSmtp;
  templates: {
    default?: string; // Base tone / cover letter style notes
  };
  createdAt: Date;
  updatedAt: Date;
}
