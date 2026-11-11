import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import LanguageSelector from '@/components/LanguageSelector';
import { useT } from '@/i18n/useT';
import { I18nProvider } from '@/i18n/provider';
import { useFormat } from '@/i18n/useFormat';
import { storedLanguage, translate } from '@/i18n/context';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function LanguagePreview() {
  const { t } = useT();
  return <p>{t('auth.tagline')}</p>;
}

describe('language selector', () => {
  it('updates visible text and persists the selected language', () => {
    render(
      <I18nProvider>
        <LanguageSelector />
        <LanguagePreview />
      </I18nProvider>,
    );
    expect(screen.getByText('Pick numbers. Win big. Play smart.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'hi' } });
    expect(screen.getByText('नंबर चुनें। जीतें। समझदारी से खेलें।')).toBeInTheDocument();
    expect(localStorage.getItem('betzone_language')).toBe('hi');
  });
});

function DatePreview() {
  const { formatDate } = useFormat();
  return <p data-testid="date">{formatDate('2026-11-11T06:30:00Z', { month: 'long' })}</p>;
}

describe('language storage failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.lang = 'en';
  });

  it('falls back to English when localStorage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(storedLanguage()).toBe('en');
    render(<I18nProvider><LanguagePreview /></I18nProvider>);
    expect(screen.getByText('Pick numbers. Win big. Play smart.')).toBeInTheDocument();
  });

  it('still switches language, html lang and formatted dates when localStorage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    render(
      <I18nProvider>
        <LanguageSelector />
        <LanguagePreview />
        <DatePreview />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByTestId('date')).toHaveTextContent('November');
    expect(() => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'mr' } });
    }).not.toThrow();
    expect(screen.getByText(translate('auth.tagline', 'mr'))).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('mr');
    expect(screen.getByTestId('date')).not.toHaveTextContent('November');
    expect(screen.getByTestId('date').textContent).toBe(new Intl.DateTimeFormat('mr-IN', { month: 'long', timeZone: 'Asia/Kolkata' }).format(new Date('2026-11-11T06:30:00Z')));
  });
});
