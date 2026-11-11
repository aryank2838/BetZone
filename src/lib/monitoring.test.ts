import { afterEach, describe, expect, it, vi } from 'vitest';

const sentryMock = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
}));

vi.mock('@sentry/react', () => sentryMock);

import { initializeMonitoring } from '@/lib/monitoring';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Sentry event scrubbing', () => {
  it('redacts sensitive values while preserving exception stack frames', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.ingest.sentry.io/123');
    initializeMonitoring();

    const options = sentryMock.init.mock.calls[0][0];
    const event = {
      user: { email: 'person@example.com', username: 'payer@bank' },
      tags: { old: 'tag' },
      message: 'Failure for person@example.com, UPI payer@bank, UTR: ABCD12345678',
      request: {
        url: 'https://app.example/path?email=person@example.com',
        method: 'POST',
        data: { email: 'person@example.com', upi_id: 'payer@bank', utr: 'ABCD12345678' },
      },
      extra: { payment: 'person@example.com payer@bank UTR: ABCD12345678' },
      breadcrumbs: [{
        message: 'Paid by person@example.com via payer@bank, reference: ABCD12345678',
        data: { email: 'person@example.com', upi: 'payer@bank', utr: 'ABCD12345678' },
      }],
      exception: {
        values: [{
          type: 'Error',
          value: 'sample',
          stacktrace: {
            frames: [{
              filename: 'https://app.example/assets/app.js',
              function: 'submitPayment',
              abs_path: 'C:/app/src/payment.ts',
            }],
          },
        }],
      },
    };

    const result = options.beforeSend(event);

    expect(result.user).toBeUndefined();
    expect(result.tags).toEqual({ app_version: '0.0.0' });
    expect(result.message).not.toContain('person@example.com');
    expect(result.message).not.toContain('payer@bank');
    expect(result.message).not.toContain('ABCD12345678');
    expect(JSON.stringify(result.request)).not.toContain('person@example.com');
    expect(JSON.stringify(result.request)).not.toContain('payer@bank');
    expect(JSON.stringify(result.request)).not.toContain('ABCD12345678');
    expect(JSON.stringify(result.extra)).not.toContain('person@example.com');
    expect(JSON.stringify(result.extra)).not.toContain('payer@bank');
    expect(JSON.stringify(result.extra)).not.toContain('ABCD12345678');
    expect(JSON.stringify(result.breadcrumbs)).not.toContain('person@example.com');
    expect(JSON.stringify(result.breadcrumbs)).not.toContain('payer@bank');
    expect(JSON.stringify(result.breadcrumbs)).not.toContain('ABCD12345678');
    expect(result.exception).toEqual(event.exception);
    expect(result.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: 'https://app.example/assets/app.js',
      function: 'submitPayment',
      abs_path: 'C:/app/src/payment.ts',
    });
  });
});
