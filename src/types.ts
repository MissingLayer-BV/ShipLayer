export type Confidence = "confirmed" | "high" | "medium" | "low" | "unknown";
export type Confirmation = "confirmed" | "needs-human-confirmation" | "not-applicable";

export interface Evidence {
  source: string;
  excerpt?: string;
  confidence: Confidence;
  kind: "project-setting" | "plist" | "entitlement" | "privacy-manifest" | "source-heuristic" | "asset" | "storekit" | "manifest";
  /** A bounded syntax match found this URL literal inside a recognizable network-request call.
   * It is evidence of source intent only, never proof that the request is reachable at runtime. */
  runtimeNetworkRequest?: boolean;
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
  /** Every field above is a human-reviewable proposal, never a fact ShipLayer invents: `init`
   * always leaves this whole object absent for a locale and records an unresolved question naming
   * exactly what an agent/human must draft (see manifestFromAnalysis in src/index.ts). Absent is
   * never read as approved — preflight.ts's metadata.<locale>.confirmation gate blocks on
   * anything other than a literal "confirmed", exactly like scenario.confirmation and every other
   * proposal confirmation in this file. */
  confirmation?: Confirmation;
}

export interface ExternalProcessor {
  name: string;
  kind: "ai" | "network" | "analytics" | "payments" | "other";
  /** True only when this processor receives data in the declared AI feature pipeline. */
  aiPipelineRecipient: boolean;
  purpose: string;
  dataCategories: string[];
  privacyPolicyUrl: string;
  protectionConfirmation: Confirmation;
  confirmation: Confirmation;
  evidence?: string[];
  /**
   * Whether this processor's receipt of data is "collection" under Apple's App Privacy
   * definition: "transmitting data off the device in a way that allows you and/or your
   * third-party partners to access it for a period longer than what is necessary to service the
   * transmitted request in real time" (developer.apple.com/app-store/app-privacy-details/). Data
   * sent only to service a request in real time and not retained beyond that — Apple's own
   * examples are an auth token or IP address on a server call, or data discarded immediately
   * after servicing the request — falls OUTSIDE that definition and is not "collection" at all;
   * that covers most CDN edge traffic and read-only API calls. This is a legal judgment ShipLayer
   * must route to a human, never decide itself: optional and unanswered
   * ("needs-human-confirmation") by default, and an absent value is treated identically to
   * "needs-human-confirmation" — it must NEVER be read as "not-collection". Only "collection"
   * requires a matching dataProcessing row per category. "not-collection" additionally requires
   * a structured, human-confirmed attestation below. ShipLayer deliberately does not infer that
   * fact from prose in any language.
   */
  collectionDetermination?: "collection" | "not-collection" | "needs-human-confirmation";
  /**
   * Required when collectionDetermination is "not-collection". This records the observable
   * real-time-service fact, its human confirmation, and a non-secret evidence reference. An
   * absent/pending/false attestation must block; free-form prose never substitutes for it.
   */
  notCollectionAttestation?: NotCollectionAttestation;
  /**
   * Optional legacy/audit note for a human reviewer. ShipLayer never semantically validates this
   * text and it cannot satisfy or override notCollectionAttestation.
   */
  collectionDeterminationReason?: string;
}

export interface NotCollectionAttestation {
  /** True only when a human has verified that the transmitted data is not retained beyond the
   * time necessary to service the request in real time, including by processor logs/databases and
   * downstream recipients. False or pending is not a not-collection clearance. */
  dataNotRetainedBeyondRealTimeService: boolean | "needs-human-confirmation";
  /** How the human established the observable fact; this is a classification of evidence, not a
   * claim ShipLayer derives from text. v0.1 clears only exact-host canonical vendor-documentation
   * evidence. Legacy first-party implementation, confidential contract, and written-confirmation
   * bases fail closed because repository/source text cannot prove runtime retention behavior. */
  basis: "first-party-implementation" | "vendor-documentation" | "contract-dpa" | "written-vendor-confirmation" | "needs-human-confirmation";
  /** A safe reference to the checked evidence. The preflight gate verifies only exact
   * hostname/policy-route linkage, never retention semantics or document content. */
  evidence: NotCollectionEvidence;
  /** Literal human confirmation of this attestation. not-applicable never clears a declared row. */
  confirmation: Confirmation;
}

export type NotCollectionEvidence =
  /** Legacy-compatible only: repo paths never clear readiness because source text cannot prove
   * runtime reachability or retention. Migrate to processor-privacy-policy. */
  | { kind: "repo-path"; path: string }
  /** Legacy-compatible shape: v0.1 never lets an arbitrary public URL clear readiness. */
  | { kind: "public-url"; url: string }
  | { kind: "processor-privacy-policy" };

export type AIDataSharing =
  | { enabled: false }
  | {
      enabled: true;
      dataSent: string[];
      purpose: string;
      processorNames: string[];
      consent: {
        shownBeforeTransmission: boolean;
        affirmativeAction: string;
        declinePath: string;
        privacyPolicyLinkVisible: boolean;
        evidence: string[];
        confirmation: Confirmation;
      };
      privacyPolicy: {
        identifiesDataAndCollectionMethod: boolean;
        identifiesAllUses: boolean;
        namesAllProcessors: boolean;
        explainsRetentionAndDeletion: boolean;
        confirmsEqualProtection: boolean;
        evidence: string[];
        confirmation: Confirmation;
      };
  };
export interface ExternalServiceDecision {
  finding: string;
  disposition: "declared-processor" | "not-an-external-processor";
  /** Required when a display-name processor's canonical policy host is linked through a scanner
   * runtime endpoint. This is an exact manifest identity, never a domain guess. */
  processorName?: string;
  reason: string;
  evidence: string[];
  confirmation: Confirmation;
}
/**
 * The only way to resolve a `*.source-contradiction` blocker (source evidence disagrees with a
 * manifest declaration, e.g. StoreKit purchase code present while monetization.type is "free", or
 * a third-party AI/inference endpoint called while aiDataSharing.enabled is false) or the
 * `purchase.unavailable-source` heuristic blocker (source evidence does not visibly prove payment
 * stays unavailable while product/price data is loading or unavailable — a same-file scan that,
 * like any heuristic, can be wrong about a real paywall shaped differently than it expects).
 * `finding` identifies the exact blocker id being overridden. An override can never be expressed
 * as an empty/default value: reason and evidence are both required and non-empty, and confirmation
 * must be explicitly "confirmed" by a human.
 */
export interface SourceContradictionOverride {
  finding: string;
  reason: string;
  evidence: string[];
  confirmation: Confirmation;
}
/**
 * Answers two questions per detected runtime permission-request category (App Review 5.1.1(iv)):
 * (1) "can the user dismiss a custom screen (sheet/confirmationDialog/alert/popover) between
 * requesting this feature and the system permission prompt?", and (2) "does the denied-access
 * path offer a link to Settings?" No scanner can prove either runtime property, so both are always
 * a human declaration, never inferred. `confirmation` must be exactly "confirmed" before
 * preflight.ts trusts EITHER boolean at all — absence of a declaration, an unconfirmed one, or a
 * default/empty value must never be read as a compliant answer (see the App Review
 * app-review-and-price-gates PR history: an earlier review found this exact "absence means
 * confirmed" shape twice). Critically, a CONFIRMED declaration is not automatically compliant
 * either: `permission-flow.<category>.dismissible-screen` blocks on a confirmed
 * `dismissibleScreenBeforePrompt: true` (a written admission of the violation), and
 * `permission-flow.<category>.denied-path-settings-link` blocks unless a confirmed declaration
 * says `deniedPathOffersSettingsLink: true` — these declarations are what gates readiness, not a
 * same-file text heuristic (see settingsLinkCorroborated in preflight.ts, which is advisory only).
 * `init` always proposes `dismissibleScreenBeforePrompt: false` and
 * `deniedPathOffersSettingsLink: false` with confirmation `needs-human-confirmation` — neither
 * boolean's proposed value carries any trust until a human sets confirmation to "confirmed"
 * themselves.
 */
export interface PermissionFlowDeclaration {
  category: string;
  dismissibleScreenBeforePrompt: boolean;
  deniedPathOffersSettingsLink: boolean;
  confirmation: Confirmation;
  evidence?: string[];
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

export interface PurchasePresentation {
  localizedPriceSource: "storekit-display-price";
  localizedPriceVisibleBeforePurchase: boolean;
  purchaseDisabledUntilPriceLoaded: boolean;
  subscriptionPeriodVisibleBeforePurchase: boolean | "not-applicable";
  offerTermsVisibleBeforePurchase: boolean | "not-applicable";
  termsAndPrivacyLinksVisibleBeforePurchase: boolean | "not-applicable";
  sourceEvidence: string[];
  testEvidence: string[];
  confirmation: Confirmation;
}

export type Monetization =
  | { type: "free"; confirmation: Confirmation }
  | { type: "paid-app"; pricePointReference: string }
  | { type: "non-consumables"; products: Array<{ productId: string; referenceName: string; localizations: Record<string, { displayName: string; description: string }>; pricePointReference: string; familySharing: boolean; reviewNotes: string; reviewScreenshot: string }>; paywallNavigation: string; restorePath: string; purchasePresentation: PurchasePresentation; confirmation: Confirmation }
  | { type: "subscriptions"; group: { referenceName: string; subscriptionGroupId?: string; localizations: Record<string, { displayName: string }> }; baseTerritory: string; baseTerritoryConfirmation: Confirmation; products: SubscriptionProduct[]; paywallNavigation: string; restorePath: string; purchasePresentation: PurchasePresentation; termsUrl: string; termsOfUse: { type: "apple-standard-eula" | "custom"; confirmation: Confirmation }; privacyUrl: string; disclosureConfirmation: Confirmation; confirmation: Confirmation };

export interface ScreenshotScenario {
  id: string;
  title: string;
  launchArguments?: string[];
  steps: string[];
  /** Absent (legacy/manually-authored) is treated as confirmed. A scenario proposed from a
   * detected or templated UI-test harness is always written with "needs-human-confirmation" and
   * must never be silently promoted to "confirmed" by ShipLayer itself. */
  confirmation?: Confirmation;
  /** Marketing screenshot headline: one idea per slide (sell an outcome, not a feature list). Max
   * 100 characters, no line breaks (schema-enforced). ShipLayer never invents this — `init` always
   * leaves it absent and records an unresolved question instead. Absent renders the slide legibly
   * with the scenario title as a visibly-marked placeholder. Like every other proposed field on
   * this type, a caption's trustworthiness rides on the scenario's own `confirmation`: a scenario
   * that is not "confirmed" always renders its marketing slide with a visible draft marker,
   * whether or not it has a caption yet — see src/marketing.ts's renderSlideHtml. The rendered
   * font auto-shrinks toward the character limit, but only by an ESTIMATE (Node has no real
   * text-shaping engine): reliable for Latin-script text at or under 100 characters, but a caption
   * entirely in a wide script (CJK ideographs, kana, hangul, fullwidth forms) can still visibly
   * clip even under that limit — keep those noticeably shorter and check the rendered PNG. */
  caption?: string;
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
  permissionFlows: PermissionFlowDeclaration[];
  dataProcessing: DataProcessing[];
  externalProcessors: ExternalProcessor[];
  aiDataSharing: AIDataSharing;
  externalServiceDecisions: ExternalServiceDecision[];
  sourceContradictionOverrides: SourceContradictionOverride[];
  secondaryTargetConfirmations: SecondaryTargetConfirmation[];
  review: { contact?: { firstName?: string; lastName?: string; email?: string; phone?: string }; demoAccount?: { required: boolean; usernameEnv?: string; passwordEnv?: string; setupInstructions?: string; credentialsEnteredConfirmation?: Confirmation }; notes?: string; recordingScenarios: ScreenshotScenario[]; sampleData?: string[] };
  screenshots: { scenarios: ScreenshotScenario[]; configurations: Array<{ device: string; family: "iphone" | "ipad"; locale: string; requiredDimensions: { width: number; height: number } }>; rawOutputDir: string; marketingProjectPath?: string;
    /** Repo-root-relative directory the marketing composition project (screenshots/marketing/) renders final PNGs into, independent of whatever --out was used at generation time — see DEFAULT_MARKETING_FINAL_DIR in src/marketing.ts. Absent falls back to that default for manifests written before this field existed. */
    finalOutputDir?: string; };
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
