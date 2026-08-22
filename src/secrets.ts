/**
 * Direct credential material must never become manifest evidence, diagnostics, or generated
 * artifacts. This intentionally detects assignments/headers, not ordinary prose such as
 * "password reset" or a benign URL query like `?lang=en`.
 */
const DIRECT_CREDENTIAL = /\b(?:api[ _-]?(?:key|token)|access[ _-]?token|auth(?:orization)?[ _-]?token|client[ _-]?secret|secret|password|private[ _-]?key|bearer)\s*[:=]\s*(?:["']?)[^\s"']+/i;
const SENSITIVE_URL_PARAMETER = /(?:^|[_-])(?:api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|secret|password|private[_-]?key|bearer|credential|signature|sig|token|key|code)(?:$|[_-])/i;

export function containsDirectCredentialMaterial(value: string): boolean {
  return /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i.test(value)
    || DIRECT_CREDENTIAL.test(value)
    || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value);
}

/** URL userinfo is always credential material. Benign navigation state such as `?lang=en` or
 * `#retention` remains valid, while credential-shaped parameters are not. This supplements, not
 * replaces, direct-content detection above. */
export function urlContainsCredentialMaterial(url: URL): boolean {
  if (url.username || url.password) return true;
  if (containsDirectCredentialMaterial(`${url.search}\n${url.hash}`)) return true;
  try {
    return [url.search, url.hash.replace(/^#/, "")].some((component) => [...new URLSearchParams(component).keys()].some((key) => SENSITIVE_URL_PARAMETER.test(key)));
  } catch { return true; }
}
