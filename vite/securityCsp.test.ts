import { describe, expect, it } from 'vitest';
import { createContentSecurityPolicy, securityCspPlugin } from './securityCsp';

const productionEnv = {
  VITE_SUPABASE_URL: 'https://project.supabase.co',
  VITE_SITE_URL: 'https://betzone.example.org',
};

describe('content security policy', () => {
  it('keeps localhost websocket sources out of production and adds Sentry only when configured', () => {
    const production = createContentSecurityPolicy('production', {
      ...productionEnv,
      VITE_SENTRY_DSN: 'https://public@o123.ingest.sentry.io/456',
    });
    expect(production).toContain("connect-src 'self' https://project.supabase.co https://o123.ingest.sentry.io");
    expect(production).not.toContain('ws://localhost');
    expect(production).not.toContain('ws://127.0.0.1');
    expect(production).not.toContain('wss://*.supabase.co');

    const withoutDsn = createContentSecurityPolicy('production', productionEnv);
    expect(withoutDsn).not.toContain('sentry.io');

    const development = createContentSecurityPolicy('development', productionEnv);
    expect(development).toContain('ws://localhost:*');
    expect(development).toContain('ws://127.0.0.1:*');
  });

  it.each([
    [{ VITE_SITE_URL: productionEnv.VITE_SITE_URL }, 'VITE_SUPABASE_URL'],
    [{ VITE_SUPABASE_URL: productionEnv.VITE_SUPABASE_URL }, 'VITE_SITE_URL'],
    [{ ...productionEnv, VITE_SUPABASE_URL: 'https://example.supabase.co' }, 'VITE_SUPABASE_URL'],
    [{ ...productionEnv, VITE_SITE_URL: 'http://localhost:3000' }, 'VITE_SITE_URL'],
  ])('rejects missing or placeholder production URLs', (env, name) => {
    expect(() => createContentSecurityPolicy('production', env)).toThrow(name);
  });

  it('injects the generated policy into index.html', () => {
    const plugin = securityCspPlugin('production', productionEnv);
    expect(plugin.transformIndexHtml?.('<meta content="__BETZONE_CSP__">'))
      .toContain("connect-src 'self' https://project.supabase.co");
  });
});
