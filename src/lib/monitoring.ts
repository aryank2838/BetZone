import * as Sentry from '@sentry/react';

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

export function initializeMonitoring() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
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
      event.extra = scrub(event.extra) as Record<string, unknown> | undefined;
      event.breadcrumbs = scrub(event.breadcrumbs) as typeof event.breadcrumbs;
      return event;
    },
  });
  Sentry.setTag('app_version', APP_VERSION);
}
