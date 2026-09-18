import type { Confirmation } from "./types.js";

export type PlayScope = "listings" | "release" | "all";
export type PlayReleaseStatus = "draft" | "completed";

export interface PlayManifest {
  schemaVersion: 1;
  packageName: string;
  metadata: {
    directory: string;
    confirmation: Confirmation;
  };
  /** Human-confirmed Google Play policy questionnaires. Google blocks releases until
   * the content rating, target audience, data safety section, and ads declaration are
   * completed; a privacy policy and contact email are required for listings that
   * collect sensitive data or need user contact. */
  policy: {
    contentRating: Confirmation;
    targetAudience: Confirmation;
    dataSafety: Confirmation;
    adsDeclaration: Confirmation;
    privacyPolicy: Confirmation;
    contactEmail: Confirmation;
  };
  release?: {
    versionCode: number;
    versionName: string;
    bundle: string;
    track: string;
    status: PlayReleaseStatus;
    confirmation: Confirmation;
  };
  sync: {
    mode: "dry-run" | "apply";
    accessTokenEnv?: string;
    serviceAccountJsonEnv?: string;
  };
}

export interface PlayOperation {
  id: string;
  action: "create" | "update" | "upload";
  resource: string;
  description: string;
  safety: "requires-apply";
  status: "planned" | "already-matches" | "applied";
}

export interface PlayPlan {
  mode: "remote-preview";
  packageName: string;
  scope: PlayScope;
  operations: PlayOperation[];
  credentialsPresent: boolean;
  warnings: string[];
  /** Google exposes listings only inside an edit. Preview creates and then deletes an
   * ephemeral edit; it never validates or commits that edit. */
  ephemeralEditDeleted: boolean;
}

export interface PlayApplyResult {
  applied: boolean;
  committed: boolean;
  operations: PlayOperation[];
  warnings: string[];
}
