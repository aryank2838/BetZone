import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { viewForOpenLink, useNav } from '@/lib/useNav';
import { readPushState, VAPID_PUBLIC_KEY } from '@/lib/push';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rpcMock.mockReset();
  window.history.replaceState(null, '', '/');
});

describe('notification links', () => {
  it('maps ?open= targets to screens', () => {
    expect(viewForOpenLink('/?open=money')).toBe('balance');
    expect(viewForOpenLink('/?open=bets')).toBe('mybets');
    expect(viewForOpenLink('/?open=admin')).toBeNull();
    expect(viewForOpenLink('/')).toBeNull();
  });

  it('opens the linked screen on load and removes the parameter', () => {
    window.history.replaceState(null, '', '/?open=money');
    const { result } = renderHook(() => useNav());
    expect(result.current.nav.view).toBe('balance');
    expect(window.location.search).toBe('');
  });
});

/** A browser with push support, permission and (optionally) a subscription. */
function stubPushBrowser({ permission, subscribed }: { permission: NotificationPermission; subscribed: boolean }) {
  const key = Uint8Array.from(atob(VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) => c.charCodeAt(0));
  const subscription = {
    endpoint: 'https://push.example/sub/1',
    options: { applicationServerKey: key.buffer },
    toJSON: () => ({ endpoint: 'https://push.example/sub/1', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } }),
    unsubscribe: vi.fn(async () => true),
  };
  const pushManager = {
    getSubscription: vi.fn(async () => (subscribed ? subscription : null)),
    subscribe: vi.fn(async () => subscription),
  };
  const Notification = { permission, requestPermission: vi.fn(async () => 'granted' as NotificationPermission) };
  vi.stubGlobal('Notification', Notification);
  vi.stubGlobal('PushManager', function PushManager() {});
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn(async () => ({ pushManager })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  return { subscription, pushManager, Notification };
}

describe('push state', () => {
  it('reports unsupported browsers', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    // jsdom has no PushManager or Notification.
    expect(await readPushState()).toBe('unsupported');
  });

  it('reports blocked, off and on', async () => {
    stubPushBrowser({ permission: 'denied', subscribed: false });
    expect(await readPushState()).toBe('blocked');
    stubPushBrowser({ permission: 'default', subscribed: false });
    expect(await readPushState()).toBe('off');
    stubPushBrowser({ permission: 'granted', subscribed: true });
    expect(await readPushState()).toBe('on');
  });
});

describe('PushNotificationsCard', () => {
  it('turns notifications on and saves the subscription with the app language', async () => {
    const { pushManager, Notification } = stubPushBrowser({ permission: 'default', subscribed: false });
    rpcMock.mockResolvedValue({ error: null });
    const { PushNotificationsCard } = await import('@/components/PushNotifications');
    render(<PushNotificationsCard />);

    const button = await screen.findByRole('button', { name: 'Turn on notifications' });
    await act(async () => { fireEvent.click(button); });

    expect(Notification.requestPermission).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(rpcMock).toHaveBeenCalledWith('save_push_subscription', {
      p_endpoint: 'https://push.example/sub/1',
      p_p256dh: 'p'.repeat(87),
      p_auth: 'a'.repeat(22),
      p_language: 'en',
    });
    expect(await screen.findByText('Notifications are on for this device.')).toBeInTheDocument();
  });

  it('turns notifications off for this device', async () => {
    const { subscription } = stubPushBrowser({ permission: 'granted', subscribed: true });
    rpcMock.mockResolvedValue({ error: null });
    const { PushNotificationsCard } = await import('@/components/PushNotifications');
    render(<PushNotificationsCard />);

    const button = await screen.findByRole('button', { name: 'Turn off' });
    await act(async () => { fireEvent.click(button); });

    expect(rpcMock).toHaveBeenCalledWith('delete_push_subscription', { p_endpoint: 'https://push.example/sub/1' });
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });
});
