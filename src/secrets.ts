/**
 * Direct credential material must never become manifest evidence, diagnostics, or generated
 * artifacts. This intentionally detects assignments/headers, not ordinary prose such as
 * "password reset" or a benign URL query like `?lang=en`.
 */
const DIRECT_CREDENTIAL = /(?:\b(?:api[ _-]?(?:key|token)|access[ _-]?token|auth(?:orization)?[ _-]?token|client[ _-]?secret|secret|password|private[ _-]?key|bearer)\s*[:=]\s*(?:["']?)[^\s"']+|\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+\/-]{8,}|\bbearer\s+[A-Za-z0-9._~+\/-]{8,})/i;
const SENSITIVE_URL_PARAMETER = /(?:^|[_-])(?:api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|secret|password|private[_-]?key|bearer|credential|signature|sig|token|key|code)(?:$|[_-])/i;
// A URL path is not usually secret material, but these markers become credential-shaped when
// followed by a value.  Deliberately keep `auth`, `password`, and `key` out of this set: they are
// common public-navigation routes. They are checked only when their following material itself
// looks like a credential. This avoids a brittle route allowlist such as auth/login/callback.
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
    // A scanner deliberately retains query *names* for endpoint identity while
    // discarding values. A bare `?api_key` therefore is not credential material
    // by itself; reject it only when the sensitive-looking key carries a value.
    if ([url.search, url.hash.replace(/^#/, "")].some((component) => [...new URLSearchParams(component).entries()].some(([key, value]) => SENSITIVE_URL_PARAMETER.test(key) && value.trim().length > 0))) return true;
    return Boolean(redactedCredentialPath(url.pathname));
  } catch { return true; }
}

/** Returns a safe replacement path when a URL path is credential-shaped. Scanner output and
 * generated artifacts use this same structural policy, so a path accepted by a less strict
 * scanner formatter can never reintroduce material that manifest validation would reject. */
export function redactedCredentialPath(pathname: string): string | undefined {
  const segments = canonicalPathSegments(pathname);
  if (segments.some(isHighSignalCredentialPathValue)) return "/:redacted";
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const folded = segment.toLowerCase();
    const remaining = segments.slice(index + 1);
    if (isStrongCredentialPathMarker(segment) && remaining.length) return "/:redacted";
    // OAuth authorization-code routes are public until a literal code value follows `/oauth/code`.
    if (folded === "oauth" && remaining[0]?.toLowerCase() === "code" && remaining.length > 1) return "/:redacted";
    if (NAVIGATION_PATH_MARKER.has(folded) && remaining.some(looksLikeCredentialValue)) return "/:redacted";
  }
  return undefined;
}

/** Separators are presentation, not a security boundary: `api_key`, `API.KEY`, `api--key`, and
 * even `token-s` normalize to the same marker family. Match only complete marker words so normal
 * routes such as `/key/reference` and `/authentication/guide` remain readable. */
function isStrongCredentialPathMarker(segment: string): boolean {
  const compact = segment.toLowerCase().replace(/-/g, "");
  return /^(?:tokens?|accesstokens?|apitokens?|apikeys?|secrets?|clientsecrets?|credentials?|signatures?|sigs?|bearers?|authtokens?|privatekeys?|oauthcodes?)$/.test(compact);
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
  return value
    .normalize("NFKC")
    .replace(DEFAULT_IGNORABLE_OR_CONTROL, "")
    .trim()
    .replace(/[\s._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** High-confidence values only. This is not a claim that every opaque URL segment is a secret;
 * it is the narrow condition under which an ordinary auth/password/key navigation route is
 * redacted rather than preserved in a generated artifact. */
function isHighSignalCredentialPathValue(segment: string): boolean {
  if (/(?:^|-)(?:secret|sekrit)(?:-|$)/i.test(segment)) return true;
  if (/^(?:sk|pk|rk|ghp|github-pat)-[a-z0-9_-]{8,}$/i.test(segment)) return true;
  // Opaque high-entropy material is never helpful in a release artifact. Require mixed classes
  // rather than treating an ordinary long article slug as credential material.
  return /^(?=.{24,}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z0-9_-]+$/.test(segment);
}

function looksLikeCredentialValue(segment: string): boolean {
  if (isHighSignalCredentialPathValue(segment)) return true;
  if (/(?:^|-)(?:secret|sekrit|token|api-key|access-token|client-secret|private-key|credential|signature|bearer)(?:-|$)/i.test(segment)) return true;
  return false;
}
