// Sentry is loaded on demand (only when a DSN is set) to keep it out of the
// first download. Errors reported before it finishes loading are queued.
type SentryModule = typeof import('@sentry/react');
let sentry: SentryModule | null = null;
const queued: unknown[] = [];

const APP_VERSION = '0.0.0';
const SENSITIVE_KEY = /email|upi|payment.?ref|utr|screenshot|image|file|cookie|authorization|token/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UPI = /\b[A-Z0-9._-]{2,}@[A-Z]{2,}\b/gi;
const LONG_IDENTIFIER = /\b(?=[A-Z0-9]{8,30}\b)(?=[A-Z0-9]*\d)[A-Z0-9]+\b/gi;
const IMAGE_FILENAME = /\b[^\s/\\]+\.(?:png|jpe?g|webp|gif)\b/gi;

function scrub(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[Filtered]';
  if (typeof value === 'string') {
    return value
      .replace(EMAIL, '[email]')
      .replace(UPI, '[upi]')
      .replace(/(utr|reference|payment ref(?:erence)?)\s*[:=]\s*[a-z0-9-]{8,30}/gi, '$1=[reference]')
      .replace(IMAGE_FILENAME, '[image]')
      .replace(LONG_IDENTIFIER, '[identifier]');
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, scrub(child, childKey)]));
  }
  return value;
}

export async function initializeMonitoring() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  const Sentry = await import('@sentry/react');
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    beforeSend(event) {
      event.user = undefined;
      event.tags = { app_version: APP_VERSION };
      if (event.request) {
        const request = scrub(event.request) as typeof event.request;
        event.request = { ...request, url: location.origin, method: event.request.method };
      }
      if (event.message) event.message = scrub(event.message) as string;
      // Exception messages can quote user input; scrub only the text, never the stack trace.
      if (event.exception?.values) {
        event.exception = {
          ...event.exception,
          values: event.exception.values.map((exception) => (
            typeof exception.value === 'string' ? { ...exception, value: scrub(exception.value) as string } : exception
          )),
        };
      }
      event.extra = scrub(event.extra) as Record<string, unknown> | undefined;
      event.breadcrumbs = scrub(event.breadcrumbs) as typeof event.breadcrumbs;
      return event;
    },
  });
  Sentry.setTag('app_version', APP_VERSION);
  sentry = Sentry;
  for (const error of queued.splice(0)) Sentry.captureException(error, { tags: { app_version: APP_VERSION } });
}

/** Reports an error to Sentry when monitoring is configured; otherwise does nothing. */
export function reportError(error: unknown) {
  if (!import.meta.env.VITE_SENTRY_DSN) return;
  if (sentry) sentry.captureException(error, { tags: { app_version: APP_VERSION } });
  else if (queued.length < 20) queued.push(error);
}
