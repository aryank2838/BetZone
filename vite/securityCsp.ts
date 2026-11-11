import type { Plugin } from 'vite';

type BuildEnvironment = Record<string, string>;

function configuredOrigin(value: string, name: string, required: boolean): string | null {
  if (!value) {
    if (required) throw new Error(`${name} must be set for production builds.`);
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  return url.origin;
}

function isPlaceholder(value: string) {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === 'example.supabase.co'
    || hostname.endsWith('.example')
    || hostname.startsWith('your-');
}

export function createContentSecurityPolicy(mode: string, env: BuildEnvironment) {
  const production = mode === 'production';
  const supabaseUrl = env.VITE_SUPABASE_URL ?? '';
  const siteUrl = env.VITE_SITE_URL ?? '';

  if (production) {
    for (const [name, value] of [
      ['VITE_SUPABASE_URL', supabaseUrl],
      ['VITE_SITE_URL', siteUrl],
    ] as const) {
      if (!value.trim()) throw new Error(`${name} must be set for production builds.`);
      configuredOrigin(value, name, true);
      if (isPlaceholder(value)) throw new Error(`${name} must not be a placeholder in production builds.`);
    }
  }

  const supabaseOrigin = configuredOrigin(supabaseUrl, 'VITE_SUPABASE_URL', production);
  const sentryOrigin = env.VITE_SENTRY_DSN
    ? configuredOrigin(env.VITE_SENTRY_DSN, 'VITE_SENTRY_DSN', true)
    : null;
  const connectSources = ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])];
  if (sentryOrigin) connectSources.push(sentryOrigin);
  if (!production) connectSources.push('ws://localhost:*', 'ws://127.0.0.1:*');

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    `img-src 'self' data: blob:${supabaseOrigin ? ` ${supabaseOrigin}` : ''}`,
  ].join('; ');
}

export function securityCspPlugin(mode: string, env: BuildEnvironment): Plugin {
  return {
    name: 'betzone-content-security-policy',
    transformIndexHtml(html) {
      return html.replace('__BETZONE_CSP__', createContentSecurityPolicy(mode, env));
    },
  };
}
