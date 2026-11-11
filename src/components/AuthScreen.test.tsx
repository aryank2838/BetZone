import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import AuthScreen from '@/components/AuthScreen';
import { TERMS_VERSION } from '@/lib/terms';

const { authMock } = vi.hoisted(() => ({
  authMock: {
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    resend: vi.fn(),
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: authMock },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('AuthScreen signup confirmation', () => {
  it('enforces one confirmation request per cooldown', async () => {
    vi.useFakeTimers();
    authMock.signUp.mockResolvedValue({ data: { session: null }, error: null });
    authMock.resend.mockResolvedValue({ error: null });
    render(<AuthScreen />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test User' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByLabelText(/I am 18 or older/));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });

    expect(authMock.signUp).toHaveBeenCalledWith({
      email: 'test@example.com',
      password: 'password123',
      options: { data: { display_name: 'Test User', accepted_terms: true, terms_version: TERMS_VERSION } },
    });
    expect(screen.getByRole('button', { name: 'Resend email (60s)' })).toBeDisabled();

    for (let second = 0; second < 60; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    const resendButton = screen.getByRole('button', { name: 'Resend email' });
    expect(resendButton).toBeEnabled();
    await act(async () => {
      fireEvent.click(resendButton);
    });

    expect(authMock.resend).toHaveBeenCalledTimes(1);
    expect(authMock.resend).toHaveBeenCalledWith({ type: 'signup', email: 'test@example.com' });
    expect(screen.getByRole('button', { name: 'Resend email (60s)' })).toBeDisabled();
  });
});

it('submits the expected sign-in credentials', async () => {
  authMock.signInWithPassword.mockResolvedValue({ error: null });
  render(<AuthScreen />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Log in' })[0]);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });

  const loginForm = screen.getByLabelText('Email').closest('form');
  expect(loginForm).not.toBeNull();
  await act(async () => {
    fireEvent.click(within(loginForm!).getByRole('button', { name: 'Log in' }));
  });

  expect(authMock.signInWithPassword).toHaveBeenCalledWith({
    email: 'test@example.com',
    password: 'password123',
  });
});
