export type Confidence = "confirmed" | "high" | "medium" | "low" | "unknown";
export type Confirmation = "confirmed" | "needs-human-confirmation" | "not-applicable";

export interface Evidence {
  source: string;
  excerpt?: string;
  confidence: Confidence;
  kind: "project-setting" | "plist" | "entitlement" | "privacy-manifest" | "source-heuristic" | "asset" | "storekit" | "manifest";
}

export interface Finding {
  key: string;
  value: unknown;
  evidence: Evidence[];
  confidence: Confidence;
  proposal?: boolean;
  message?: string;
}

export interface AnalysisReport {
  schemaVersion: 1;
  repository: string;
  scannedAt: string;
  project: { xcodeProjects: string[]; workspaces: string[]; projectYml: string[] };
  findings: Finding[];
  contradictions: string[];
  unresolvedQuestions: string[];
  ignored: { directories: string[]; filesOverLimit: number; filesOverLimitPaths: string[]; filesScanned: number; entriesVisited: number; unreadable: string[]; symlinksIgnored: string[]; symlinkDirectoriesIgnored: string[]; symlinkFilesIgnored: string[]; truncated: boolean };
}

export interface LocaleCopy {
  name?: string;
  subtitle?: string;
  promotionalText?: string;
  description?: string;
  keywords?: string[];
  whatsNew?: string;
}

export interface ExternalProcessor {
  name: string;
  purpose: string;
  dataCategories: string[];
  confirmation: Confirmation;
  evidence?: string[];
}
export interface ExternalServiceDecision {
  finding: string;
  disposition: "declared-processor" | "not-an-external-processor";
  reason: string;
  evidence: string[];
  confirmation: Confirmation;
}
export interface SecondaryTargetConfirmation {
  bundleId: string;
  classification: "extension" | "widget" | "other-app";
  evidence: string[];
  confirmation: Confirmation;
}

export interface DataProcessing {
  category: string;
  purpose: string[];
  linkedToIdentity: boolean | "unknown";
  usedForTracking: boolean | "unknown";
  confirmation: Confirmation;
  evidence?: string[];
}

export interface SubscriptionProduct {
  productId: string;
  referenceName: string;
  duration: "P1W" | "P1M" | "P2M" | "P3M" | "P6M" | "P1Y";
  level: number;
  localizations: Record<string, { displayName: string; description: string }>;
  pricePointReference: string;
  introductoryOffer?: { type: "free-trial" | "pay-up-front" | "pay-as-you-go"; duration: "P3D" | "P1W" | "P2W" | "P1M" | "P2M" | "P3M" | "P6M" | "P1Y"; pricePointReference?: string; numberOfPeriods?: number };
  familySharing: boolean;
  reviewNotes: string;
  reviewScreenshot: string;
}

export type Monetization =
  | { type: "free" }
  | { type: "paid-app"; pricePointReference: string }
  | { type: "non-consumables"; products: Array<{ productId: string; referenceName: string; localizations: Record<string, { displayName: string; description: string }>; pricePointReference: string; familySharing: boolean; reviewNotes: string; reviewScreenshot: string }>; paywallNavigation: string; restorePath: string; confirmation: Confirmation }
  | { type: "subscriptions"; group: { referenceName: string; subscriptionGroupId?: string; localizations: Record<string, { displayName: string }> }; baseTerritory: string; baseTerritoryConfirmation: Confirmation; products: SubscriptionProduct[]; paywallNavigation: string; restorePath: string; termsUrl: string; termsOfUse: { type: "apple-standard-eula" | "custom"; confirmation: Confirmation }; privacyUrl: string; disclosureConfirmation: Confirmation; confirmation: Confirmation };

export interface ScreenshotScenario {
  id: string;
  title: string;
  launchArguments?: string[];
  steps: string[];
}

export interface ShipLayerManifest {
  schemaVersion: 1;
  app: {
    name: string;
    bundleId: string;
    appleTeamId?: string;
    appStoreAppId?: string;
    sku?: string;
    version?: string;
    build?: string;
    deploymentTarget?: string;
    productionIconCatalog?: string;
    /** A selected Xcode 26 Icon Composer .icon asset. Mutually exclusive with catalog selection. */
    productionIconAsset?: string;
    productionIconAssetConfirmation?: Confirmation;
    deviceFamilies: Array<"iphone" | "ipad">;
    locales: string[];
    primaryLocale: string;
    primaryCategory?: string;
    secondaryCategory?: string;
    availability: "all" | "selected";
    releaseMode: "manual" | "automatic" | "scheduled";
  };
  contacts: { supportEmail?: string; supportUrl?: string; marketingUrl?: string; privacyUrl?: string; copyright?: string };
  metadata: { localizations: Record<string, LocaleCopy> };
  permissions: Array<{ key: string; purpose?: string; confirmation: Confirmation; evidence?: string[] }>;
  dataProcessing: DataProcessing[];
  externalProcessors: ExternalProcessor[];
  externalServiceDecisions: ExternalServiceDecision[];
  secondaryTargetConfirmations: SecondaryTargetConfirmation[];
  review: { contact?: { firstName?: string; lastName?: string; email?: string; phone?: string }; demoAccount?: { required: boolean; usernameEnv?: string; passwordEnv?: string; setupInstructions?: string; credentialsEnteredConfirmation?: Confirmation }; notes?: string; recordingScenarios: ScreenshotScenario[]; sampleData?: string[] };
  screenshots: { scenarios: ScreenshotScenario[]; configurations: Array<{ device: string; family: "iphone" | "ipad"; locale: string; requiredDimensions: { width: number; height: number } }>; rawOutputDir: string; marketingProjectPath?: string };
  monetization: Monetization;
  build: { signing: "automatic" | "manual" | "unknown"; exportCompliance?: "exempt" | "documentation-required" | "unknown"; testFlightUpload?: boolean };
  sync: { mode: "dry-run" | "apply"; appStoreConnectKeyIdEnv?: string; issuerIdEnv?: string; privateKeyPathEnv?: string };
  confirmations: { privacy: Confirmation; legal: Confirmation; trader: Confirmation; paidAgreements: Confirmation; ageRating: Confirmation; contentRights: Confirmation };
}

export type CheckSeverity = "pass" | "warn" | "block";
export interface CheckResult { id: string; severity: CheckSeverity; message: string; path?: string; remediation?: string }
export interface PreflightReport { repository: string; results: CheckResult[]; summary: { pass: number; warn: number; block: number }; canPrepare: boolean; canApply: boolean; canSubmit: boolean }

export interface AscOperation { id: string; action: "read" | "create" | "update" | "upload" | "submit" | "manual"; resource: string; description: string; safety: "read-only" | "requires-apply" | "requires-submit" | "manual"; status: "planned" | "unsupported" | "already-matches" }
export interface AscPlan { mode: "offline" | "remote"; operations: AscOperation[]; credentialsPresent: boolean; warnings: string[] }
