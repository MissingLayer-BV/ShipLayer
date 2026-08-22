/**
 * Direct credential material must never become manifest evidence, diagnostics, or generated
 * artifacts. This intentionally detects assignments/headers, not ordinary prose such as
 * "password reset" or a benign URL query like `?lang=en`.
 */
const DIRECT_CREDENTIAL = /(?:\b(?:api[ _-]?(?:key|token)|access[ _-]?token|auth(?:orization)?[ _-]?token|client[ _-]?secret|secret|password|private[ _-]?key|bearer)\s*[:=]\s*(?:["']?)[^\s"']+|\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+\/-]{8,}|\bbearer\s+[A-Za-z0-9._~+\/-]{8,})/i;
// A URL path is not usually secret material. A marker is unsafe only when it is followed by a
// credential-shaped value/context; terminology alone is normal in documentation and navigation.
// This deliberately avoids a route allowlist such as auth/login/callback.
const NAVIGATION_PATH_MARKER = new Set(["auth", "password", "key"]);
const DEFAULT_IGNORABLE_OR_CONTROL = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Cs}]/gu;
const MAX_PERCENT_DECODES = 4;

export function containsDirectCredentialMaterial(value: string): boolean {
  return /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i.test(value)
    || DIRECT_CREDENTIAL.test(value)
    || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value);
}

/** Detect credential-bearing URLs embedded in free text before an artifact can echo them. */
export function containsCredentialUrlMaterial(value: string): boolean {
  for (const candidate of value.match(/https?:\/\/[^\s"'<>]+/g) || []) {
    try { if (urlContainsCredentialMaterial(new URL(candidate))) return true; }
    catch { /* malformed URLs are handled by their own validation */ }
  }
  return false;
}

/** URL userinfo is always credential material. Benign navigation state such as `?lang=en` or
 * `#retention` remains valid, while credential-shaped parameters are not. This supplements, not
 * replaces, direct-content detection above. */
export function urlContainsCredentialMaterial(url: URL): boolean {
  if (url.username || url.password) return true;
  if (containsDirectCredentialMaterial(`${url.search}\n${url.hash}`)) return true;
  try {
    // A scanner retains query *names* for endpoint identity while discarding values. A bare
    // `?api_key` is therefore not credential material by itself; reject it only when the
    // normalized credential-shaped key carries a value. Key normalization matches path handling.
    if ([url.search, url.hash.replace(/^#/, "")].some(hasCredentialParameterValue)) return true;
    return Boolean(redactedCredentialPath(url.pathname));
  } catch { return true; }
}

/** Returns a safe replacement path when a URL path is credential-shaped. Scanner output and
 * generated artifacts use this same structural policy, so a path accepted by a less strict
 * scanner formatter can never reintroduce material that manifest validation would reject. */
export function redactedCredentialPath(pathname: string): string | undefined {
  const segments = canonicalPathSegments(pathname);
  for (let index = 0; index < segments.length; index++) {
    const markerWidth = credentialContextWidth(segments, index);
    if (markerWidth && segments.slice(index + markerWidth).some(looksLikeCredentialValue)) return "/:redacted";
  }
  const directSecretIndex = segments.findIndex(isHighSignalCredentialPathValue);
  // Preserve only the harmless route prefix for a standalone credential-shaped segment. This
  // keeps diagnostics useful (for example `/webhook/:redacted`) without retaining the value.
  if (directSecretIndex >= 0) return `/${segments.slice(0, directSecretIndex).join("/")}${directSecretIndex ? "/" : ""}:redacted`;
  return undefined;
}

/** Returns the number of segments in a complete credential marker. Separators and nesting are
 * presentation details: api-key, api/key, api%2Bkey, private/key, and oauth2/code are equivalent
 * contexts. Complete marker matching keeps `/docs/api-key/rotation` and `/signature/verification`
 * readable until an actual credential-shaped value appears. */
function credentialContextWidth(segments: string[], index: number): number | undefined {
  const one = normalizedUrlIdentifier(segments[index]);
  const two = segments[index + 1] ? `${one}-${normalizedUrlIdentifier(segments[index + 1])}` : "";
  if (/^(?:api|access|auth|authorization|client|private|oauth2?)-(?:key|token|secret|code)$/.test(two)) return 2;
  if (isCredentialMarker(one)) return 1;
  if (NAVIGATION_PATH_MARKER.has(one)) return 1;
  return undefined;
}

function isCredentialMarker(value: string): boolean {
  const compact = value.replace(/-/g, "");
  return /^(?:tokens?|accesstokens?|apitokens?|apikeys?|secrets?|clientsecrets?|credentials?|signatures?|sigs?|bearers?|authtokens?|authorizationtokens?|authorizationcodes?|privatekeys?|oauth2?codes?)$/.test(compact);
}

function hasCredentialParameterValue(component: string): boolean {
  for (const [key, value] of new URLSearchParams(component).entries()) {
    if (isCredentialMarker(normalizedUrlIdentifier(key)) && value.trim().length > 0) return true;
  }
  return false;
}

/** Decode repeatedly (within a small bound), fold Unicode compatibility characters, and discard
 * invisible formatting/control characters before marker matching. This closes double-encoding and
 * zero-width bypasses without treating ordinary, readable navigation paths as credentials. */
function canonicalPathSegments(pathname: string): string[] {
  const segments: string[] = [];
  for (const rawSegment of decodeToStable(pathname).split(/[\\/]+/)) {
    const decoded = canonicalPathPart(rawSegment);
    for (const segment of decoded.split(/[\\/]+/)) {
      if (!segment || segment === ".") continue;
      if (segment === "..") { segments.pop(); continue; }
      segments.push(segment);
    }
  }
  return segments;
}

function decodeToStable(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < MAX_PERCENT_DECODES; attempt++) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { throw new Error("invalid encoded URL path"); }
    if (next === decoded) return decoded;
    decoded = next;
  }
  // Do not accept a value whose normalization still has another encoded layer: accepting it
  // would turn the iteration bound into an evasion primitive. Callers fail closed/redact on this.
  try { if (decodeURIComponent(decoded) !== decoded) throw new Error("excessively encoded URL path"); }
  catch (error) { throw error instanceof Error ? error : new Error("invalid encoded URL path"); }
  return decoded;
}

function canonicalPathPart(value: string): string {
  return canonicalUrlText(value)
    .replace(/[\s._+-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Identifier normalization is shared by path segments and query/fragment parameter names. */
function normalizedUrlIdentifier(value: string): string {
  return canonicalUrlText(value)
    .toLowerCase()
    .replace(/[\s._+\-/]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function canonicalUrlText(value: string): string {
  return decodeToStable(value)
    .normalize("NFKC")
    .replace(DEFAULT_IGNORABLE_OR_CONTROL, "")
    .trim();
}

/** High-confidence values only. This is not a claim that every opaque URL segment is a secret;
 * it is the narrow condition under which an ordinary auth/password/key navigation route is
 * redacted rather than preserved in a generated artifact. */
function isHighSignalCredentialPathValue(segment: string): boolean {
  // The words themselves are ordinary documentation terminology. Treat them as a value only
  // when they carry additional opaque material; marker/value structure is handled separately.
  if (/(?:secret|sekrit)[a-z0-9_-]{6,}$/i.test(segment)) return true;
  if (/^(?:sk|pk|rk|ghp|github-pat)-[a-z0-9_-]{8,}$/i.test(segment)) return true;
  // Opaque high-entropy material is never helpful in a release artifact. Require mixed classes
  // rather than treating an ordinary long article slug as credential material.
  return /^(?=.{24,}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z0-9_-]+$/.test(segment);
}

function looksLikeCredentialValue(segment: string): boolean {
  if (isHighSignalCredentialPathValue(segment)) return true;
  const normalized = normalizedUrlIdentifier(segment);
  // `value` and explicit credential-value names are neutral, non-secret fixtures that still
  // model a credential-bearing URL shape. Documentation navigation words do not match here.
  if (/^(?:value|credential(?:-value)?|token(?:-value)?|secret(?:-value)?|key(?:-value)?|code(?:-value)?|bearer(?:-token)?|opaque)$/.test(normalized)) return true;
  if (isCredentialMarker(normalized)) return true;
  return false;
}
