/**
 * Direct credential material must never become manifest evidence, diagnostics, or generated
 * artifacts. This intentionally detects assignments/headers, not ordinary prose such as
 * "password reset" or a benign URL query like `?lang=en`.
 */
const DIRECT_CREDENTIAL = /(?:\b(?:api[ _-]?(?:key|token)|access[ _-]?token|auth(?:orization)?[ _-]?token|client[ _-]?secret|secret|password|private[ _-]?key|bearer)\s*[:=]\s*(?:["']?)[^\s"']+|\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+\/-]{8,}|\bbearer\s+[A-Za-z0-9._~+\/-]{8,})/i;
const DEFAULT_IGNORABLE_OR_CONTROL = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Cs}]/gu;
const URL_TOKEN_SEPARATOR = /[\s\p{Pd}:~+_./]+/gu;
const MAX_PERCENT_DECODES = 4;

interface NormalizedPathSegment { tokens: string[]; }

// These are exact credential *names*, not keyword fragments. A path is sensitive only when one
// of these whole marker sequences is in an API-shaped position and a following path segment
// carries its value. This is deliberately different from classifying prose slugs such as
// `client-secret-rotation` or `secret-santa-2026` as credentials.
const PATH_MARKER_SEQUENCES = [
  ["token"], ["tokens"], ["credential"], ["credentials"], ["secret"], ["secrets"],
  ["signature"], ["signatures"], ["sig"], ["sigs"], ["bearer"], ["bearers"],
  ["api", "key"], ["api", "token"], ["access", "token"], ["client", "secret"],
  ["auth", "token"], ["authorization", "token"], ["auth", "code"], ["authorization", "code"],
  ["oauth", "code"], ["oauth2", "code"], ["private", "key"]
] as const;

// Query/fragment keys name values directly, so the single `key` and `code` forms are unsafe
// there even though `/key/reference` and `/oauth/code/examples` can be ordinary navigation.
const PARAMETER_MARKER_SEQUENCES = [...PATH_MARKER_SEQUENCES, ["key"], ["keys"], ["code"], ["codes"]] as const;

export function containsDirectCredentialMaterial(value: string): boolean {
  return /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i.test(value)
    || DIRECT_CREDENTIAL.test(value)
    || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value);
}

/** Detect credential-bearing URLs embedded in free text before an artifact can echo them. */
export function containsCredentialUrlMaterial(value: string): boolean {
  for (const candidate of value.match(/https?:\/\/[^\s"'<>]+/gi) || []) {
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
    const markerWidth = markerSequenceWidth(segments, index, PATH_MARKER_SEQUENCES);
    const value = markerWidth ? segments[index + markerWidth] : undefined;
    // A complete marker followed by an opaque value is sensitive wherever it appears. Public
    // documentation stays readable because its following segment has topic grammar (for example
    // `/docs/api-key/rotation`), rather than because its parent path is allowlisted.
    if (markerWidth && value && !isDocumentationTopic(value)) return "/:redacted";
  }
  return undefined;
}

function hasCredentialParameterValue(component: string): boolean {
  for (const [key, value] of new URLSearchParams(component).entries()) {
    if (value.trim().length > 0 && markerSequenceWidth([{ tokens: parameterTokens(key) }], 0, PARAMETER_MARKER_SEQUENCES)) return true;
  }
  return false;
}

/** Decode repeatedly (within a small bound), fold Unicode compatibility characters, and discard
 * invisible formatting/control characters before marker matching. This closes double-encoding and
 * zero-width bypasses without treating ordinary, readable navigation paths as credentials. */
function canonicalPathSegments(pathname: string): NormalizedPathSegment[] {
  const segments: NormalizedPathSegment[] = [];
  for (const rawSegment of decodeToStable(pathname).split(/[\\/]+/)) {
    const decoded = canonicalUrlText(rawSegment);
    for (const segment of decoded.split(/[\\/]+/)) {
      if (!segment || segment === ".") continue;
      if (segment === "..") { segments.pop(); continue; }
      const tokens = parameterTokens(segment);
      if (tokens.length) segments.push({ tokens });
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

/** Tokenization is shared by paths and query/fragment names. It is intentionally bounded and
 * compatibility-normalized so encoding, invisible characters, and Unicode punctuation cannot
 * create a second spelling of a credential marker. */
function parameterTokens(value: string): string[] {
  return canonicalUrlText(value)
    .toLowerCase()
    .split(URL_TOKEN_SEPARATOR)
    .filter(Boolean);
}

function canonicalUrlText(value: string): string {
  return decodeToStable(value)
    .normalize("NFKC")
    .replace(DEFAULT_IGNORABLE_OR_CONTROL, "")
    .trim();
}

function markerSequenceWidth(segments: NormalizedPathSegment[], start: number, markers: readonly (readonly string[])[]): number | undefined {
  for (const marker of markers) {
    let segmentIndex = start;
    let tokenIndex = 0;
    while (tokenIndex < marker.length && segmentIndex < segments.length) {
      const tokens = segments[segmentIndex].tokens;
      const remaining = marker.slice(tokenIndex);
      if (tokens.length > remaining.length || tokens.some((token, index) => token !== remaining[index])) break;
      tokenIndex += tokens.length;
      segmentIndex++;
    }
    if (tokenIndex === marker.length) return segmentIndex - start;
  }
  return undefined;
}

/** Topic-shaped terms describe public documentation (verification, rotation, examples) rather
 * than carrying a credential. This is a grammar rule for the value segment, not a route allowlist:
 * it applies regardless of host or marker and leaves the marker itself exact. */
function isDocumentationTopic(segment: NormalizedPathSegment): boolean {
  const value = segment.tokens.join("");
  return /(?:tion|ment|guide|guides|example|examples|reference|references|faq|overview|tutorial|tutorials|configuration|management)$/.test(value);
}
