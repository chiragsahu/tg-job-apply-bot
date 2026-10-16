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
 * Global candidate screening profile stored in user record.
 * Contains user-level details that apply across all roles.
 */
export interface CandidateProfile {
  officialName?: string | undefined;       // Official name as per Govt ID / Passport
  dob?: string | undefined;                // Date of Birth
  mobile?: string | undefined;             // Contact number
  emailId?: string | undefined;            // Contact email
  totalExperience?: string | undefined;    // Overall work experience (e.g. "5 Years")
  currentCompany?: string | undefined;     // Current employer
  currentLocation?: string | undefined;    // Current city
  preferredLocation?: string | undefined;  // Preferred work locations
  currentCtc?: string | undefined;         // Current CTC
  noticePeriod?: string | undefined;       // Notice period / LWD
  updatedAt?: Date | undefined;
}

/**
 * Role created by the user (e.g. 'Senior Backend Engineer').
 * Has a 1-to-1 relationship with an attached UserResume,
 * plus role-specific application details (relevant exp, expected CTC, holding offer).
 */
export interface UserRole {
  id: string;                              // Unique role identifier
  name: string;                            // e.g. "Senior Backend Engineer"
  resume?: UserResume;                     // 1-to-1 attached resume
  relevantExperience?: string | undefined; // e.g. "4 Years in Node.js / TypeScript"
  expectedCtc?: string | undefined;        // e.g. "22 LPA"
  holdingOffer?: string | undefined;       // e.g. "Yes - 20 LPA" or "None"
  createdAt: Date;
  updatedAt: Date;
}


/**
 * Top-level MongoDB user document.
 * Primary key for lookup is telegramId (indexed unique).
 */
export interface UserDoc {
  telegramId: number;
  username?: string;
  firstName?: string;
  profile?: CandidateProfile;
  roles?: UserRole[];
  resume?: UserResume;      // Legacy / default resume fallback
  smtp?: UserSmtp;
  templates: {
    default?: string; // Base tone / cover letter style notes
  };
  createdAt: Date;
  updatedAt: Date;
}

