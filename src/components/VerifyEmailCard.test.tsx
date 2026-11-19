import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import VerifyEmailCard from '@/components/VerifyEmailCard';
import { cleanCode } from '@/lib/verifyCode';
import { friendlyError } from '@/lib/errors';

const { supabaseMock, refreshProfileMock } = vi.hoisted(() => ({
  supabaseMock: {
    rpc: vi.fn(),
    auth: { signInWithOtp: vi.fn(), verifyOtp: vi.fn() },
  },
  refreshProfileMock: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { email: 'player@example.com' }, refreshProfile: refreshProfileMock }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VerifyEmailCard', () => {
  it('says the check happens only once', () => {
    render(<VerifyEmailCard />);
    expect(screen.getByText(/one-time step/i)).toBeTruthy();
    expect(screen.getByText(/never be asked again/i)).toBeTruthy();
  });

  it('sends a code, verifies it, then marks the email verified', async () => {
    supabaseMock.auth.signInWithOtp.mockResolvedValue({ error: null });
    supabaseMock.auth.verifyOtp.mockResolvedValue({ error: null });
    supabaseMock.rpc.mockResolvedValue({ data: { email_verified_at: '2026-11-19T10:00:00Z' }, error: null });
    refreshProfileMock.mockResolvedValue(undefined);
    const onVerified = vi.fn();
    render(<VerifyEmailCard onVerified={onVerified} />);

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    await screen.findByText(/sent a code to player@example.com/i);
    expect(supabaseMock.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'player@example.com',
      options: { shouldCreateUser: false },
    });
    // Cannot ask for another code straight away.
    expect((screen.getByRole('button', { name: /send a new code/i }) as HTMLButtonElement).disabled).toBe(true);

    const verifyButton = screen.getByRole('button', { name: /verify email/i }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(/code from the email/i), { target: { value: '12 34-5' } });
    expect(verifyButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/code from the email/i), { target: { value: '123456' } });
    fireEvent.click(verifyButton);

    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    expect(supabaseMock.auth.verifyOtp).toHaveBeenCalledWith({ email: 'player@example.com', token: '123456', type: 'email' });
    expect(supabaseMock.rpc).toHaveBeenCalledWith('mark_email_verified');
    expect(refreshProfileMock).toHaveBeenCalled();
  });

  it('explains a wrong code and does not mark the email verified', async () => {
    supabaseMock.auth.signInWithOtp.mockResolvedValue({ error: null });
    supabaseMock.auth.verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } });
    render(<VerifyEmailCard />);

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    fireEvent.change(await screen.findByLabelText(/code from the email/i), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /verify email/i }));

    await screen.findByText(/code is wrong or has expired/i);
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });
});

describe('Paste button', () => {
  const setClipboard = (readText: () => Promise<string>) => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
  };
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  const openCodeStep = async () => {
    supabaseMock.auth.signInWithOtp.mockResolvedValue({ error: null });
    render(<VerifyEmailCard />);
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    return (await screen.findByLabelText(/code from the email/i)) as HTMLInputElement;
  };

  it('fills in the copied code, keeping only the digits', async () => {
    setClipboard(() => Promise.resolve('Your code: 482 913'));
    const input = await openCodeStep();
    fireEvent.click(screen.getByRole('button', { name: /^paste$/i }));
    await waitFor(() => expect(input.value).toBe('482913'));
  });

  it('explains when the clipboard has no code', async () => {
    setClipboard(() => Promise.resolve('hello'));
    await openCodeStep();
    fireEvent.click(screen.getByRole('button', { name: /^paste$/i }));
    await screen.findByText(/no code found/i);
  });

  it('explains when the browser blocks pasting', async () => {
    setClipboard(() => Promise.reject(new Error('NotAllowedError')));
    await openCodeStep();
    fireEvent.click(screen.getByRole('button', { name: /^paste$/i }));
    await screen.findByText(/could not paste/i);
  });

  it('is hidden when the browser cannot read the clipboard', async () => {
    await openCodeStep();
    expect(screen.queryByRole('button', { name: /^paste$/i })).toBeNull();
  });
});

describe('verification helpers', () => {
  it('keeps only digits, at most 10', () => {
    expect(cleanCode(' 12-34 56 ')).toBe('123456');
    expect(cleanCode('12345678901234')).toBe('1234567890');
  });

  it('maps the database errors to plain messages', () => {
    expect(friendlyError({ message: 'EMAIL_NOT_VERIFIED' }).key).toBe('errors.emailNotVerified');
    expect(friendlyError({ message: 'EMAIL_CODE_REQUIRED' }).key).toBe('errors.emailCodeRequired');
  });
});
