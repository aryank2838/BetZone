import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANDROID_APK_PATH, checkAndroidApk, isAndroid, resetAndroidApkCheck } from './installPrompt';

const respond = (status: number, contentType: string) =>
  vi.fn().mockResolvedValue(new Response(null, { status, headers: { 'Content-Type': contentType } }));

afterEach(() => resetAndroidApkCheck());

describe('Android app download', () => {
  it('finds the APK when the server sends it as an app file', async () => {
    const fetcher = respond(200, 'application/vnd.android.package-archive');
    expect(await checkAndroidApk(fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(ANDROID_APK_PATH, expect.objectContaining({ method: 'HEAD' }));
  });

  it('treats the website page (sent for any missing file) as no APK', async () => {
    expect(await checkAndroidApk(respond(200, 'text/html; charset=utf-8'))).toBe(false);
  });

  it('treats errors and network failures as no APK', async () => {
    expect(await checkAndroidApk(respond(404, 'text/plain'))).toBe(false);
    resetAndroidApkCheck();
    expect(await checkAndroidApk(vi.fn().mockRejectedValue(new Error('offline')))).toBe(false);
  });

  it('checks only once per page load', async () => {
    const fetcher = respond(200, 'application/vnd.android.package-archive');
    await checkAndroidApk(fetcher);
    await checkAndroidApk(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('spots Android phones', () => {
    expect(isAndroid('Mozilla/5.0 (Linux; Android 14; SM-A546E) Chrome/130')).toBe(true);
    expect(isAndroid('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(false);
  });
});
