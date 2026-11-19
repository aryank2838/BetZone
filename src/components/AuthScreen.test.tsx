import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import AuthScreen from '@/components/AuthScreen';
import { TERMS_VERSION } from '@/lib/terms';

const { authMock } = vi.hoisted(() => ({
  authMock: {
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    resend: vi.fn(),
    verifyOtp: vi.fn(),
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
      options: {
        emailRedirectTo: window.location.origin,
        data: { display_name: 'Test User', accepted_terms: true, terms_version: TERMS_VERSION },
      },
    });
    expect(screen.getByText('One more step: confirm your email')).toBeInTheDocument();
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
    expect(authMock.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'test@example.com',
      options: { emailRedirectTo: window.location.origin },
    });
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

it('explains an unconfirmed email on login and offers a resend', async () => {
  authMock.signInWithPassword.mockResolvedValue({ error: { code: 'email_not_confirmed', message: 'Email not confirmed' } });
  authMock.resend.mockResolvedValue({ error: null });
  render(<AuthScreen />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Log in' })[0]);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
  const loginForm = screen.getByLabelText('Email').closest('form')!;
  await act(async () => {
    fireEvent.click(within(loginForm).getByRole('button', { name: 'Log in' }));
  });

  expect(screen.getByRole('alert')).toHaveTextContent(/isn't confirmed yet/);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resend email' }));
  });
  expect(authMock.resend).toHaveBeenCalledWith(expect.objectContaining({ type: 'signup', email: 'test@example.com' }));
});

it('explains an expired confirmation link instead of failing silently', async () => {
  window.history.replaceState(null, '', '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  render(<AuthScreen />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was already used/);
  expect(screen.getByText('Email link is invalid or has expired')).toBeInTheDocument();
  expect(window.location.hash).toBe('');
});

it('confirms the email from a token_hash link', async () => {
  authMock.verifyOtp.mockResolvedValue({ error: null });
  window.history.replaceState(null, '', '/?token_hash=abc123&type=signup');
  render(<AuthScreen />);
  expect(await screen.findByText('Your email is confirmed. Log in to continue.')).toBeInTheDocument();
  expect(authMock.verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc123', type: 'signup' });
  expect(window.location.search).toBe('');
});

describe('AuthScreen email checks', () => {
  const fillSignup = (email: string) => {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test User' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByLabelText(/I am 18 or older/));
  };

  it('asks for a real email on sign-up only', () => {
    render(<AuthScreen />);
    expect(screen.getByText(/use your real email/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(screen.queryByText(/use your real email/i)).toBeNull();
  });

  it('suggests a fix for a typo and fills it in with one tap', () => {
    render(<AuthScreen />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ravi@gmial.com' } });
    expect(screen.queryByText(/did you mean/i)).toBeNull();
    fireEvent.blur(screen.getByLabelText('Email'));
    fireEvent.click(screen.getByRole('button', { name: 'ravi@gmail.com' }));
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('ravi@gmail.com');
    expect(screen.queryByText(/did you mean/i)).toBeNull();
  });

  it('shows the typo once before creating the account, then lets the player go ahead', async () => {
    authMock.signUp.mockResolvedValue({ data: { session: {} }, error: null });
    render(<AuthScreen />);
    fillSignup('ravi@gmail.co');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });
    expect(authMock.signUp).not.toHaveBeenCalled();
    expect(screen.getByText(/did you mean/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });
    expect(authMock.signUp).toHaveBeenCalledTimes(1);
    expect(authMock.signUp.mock.calls[0][0].email).toBe('ravi@gmail.co');
  });
});
