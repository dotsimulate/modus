const SECRET_KEY = "authorization|proxy-authorization|x-api-key|api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|(?:[a-z0-9]+[_-])*token|secret|password";

export function logProviderDiagnostic(message: string): void {
  if (process.env.MODUS_PROVIDER_DIAGNOSTICS === "1") {
    console.log(message);
  }
}

/** Redact common credential forms before provider diagnostics enter logs or DB state. */
export function redactProviderDiagnostic(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [REDACTED]")
    .replace(new RegExp(`(["']?(?:${SECRET_KEY})["']?\\s*[:=]\\s*["']?)[^\\s"',;}&#]+`, "gi"), "$1[REDACTED]")
    .replace(/([?&](?:token|key|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@/");
}
