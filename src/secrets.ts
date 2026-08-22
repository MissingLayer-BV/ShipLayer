/**
 * Direct credential material must never become manifest evidence, diagnostics, or generated
 * artifacts. This intentionally detects assignments/headers, not ordinary prose such as
 * "password reset" or a benign URL query like `?lang=en`.
 */
const DIRECT_CREDENTIAL = /(?:\b(?:api[ _-]?(?:key|token)|access[ _-]?token|auth(?:orization)?[ _-]?token|client[ _-]?secret|secret|password|private[ _-]?key|bearer)\s*[:=]\s*(?:["']?)[^\s"']+|\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+\/-]{8,}|\bbearer\s+[A-Za-z0-9._~+\/-]{8,})/i;
const SENSITIVE_URL_PARAMETER = /(?:^|[_-])(?:api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|secret|password|private[_-]?key|bearer|credential|signature|sig|token|key|code)(?:$|[_-])/i;
// These path markers have no normal public-navigation interpretation once they carry a following
// segment. Do not make their safety depend on the *next* segment: `/token/login/value` is still
// credential-shaped even though `login` alone is an ordinary public route.
const HIGH_RISK_PATH_MARKER = /^(?:api[-_.]?(?:keys?|tokens?)|tokens?|access[-_.]?tokens?|secrets?|credentials?|signatures?|sigs?|bearers?)$/i;
// These three words legitimately occur in public navigation, but only the listed final pairs are
// allowed. Any additional path material is treated as a credential-shaped URL rather than guessed
// safe from prose or a generic allowlist.
const NAVIGATION_PATH_MARKER = /^(?:auth|password|key)$/i;
const BENIGN_TERMINAL_PATH_PAIRS = new Set(["auth/guide", "auth/login", "auth/logout", "password/reset", "key/faq"]);

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
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (HIGH_RISK_PATH_MARKER.test(segment) && index + 1 < segments.length) return "/:redacted";
    if (NAVIGATION_PATH_MARKER.test(segment) && index + 1 < segments.length) {
      const pair = `${segment}/${segments[index + 1]}`;
      if (index + 2 >= segments.length && BENIGN_TERMINAL_PATH_PAIRS.has(pair)) continue;
      return "/:redacted";
    }
  }
  return undefined;
}

/** Decode and resolve URL path structure before checking credential markers. A credential cannot
 * evade the contract with case, percent encoding, `.`/`..`, repeated separators, or a decoded
 * slash/backslash tucked inside one segment. */
function canonicalPathSegments(pathname: string): string[] {
  const segments: string[] = [];
  for (const rawSegment of pathname.split(/[\\/]+/)) {
    let decoded: string;
    try { decoded = decodeURIComponent(rawSegment).normalize("NFKC").trim().toLowerCase(); } catch { throw new Error("invalid encoded URL path"); }
    for (const segment of decoded.split(/[\\/]+/)) {
      if (!segment || segment === ".") continue;
      if (segment === "..") { segments.pop(); continue; }
      segments.push(segment);
    }
  }
  return segments;
}
