import { describe, expect, it } from 'vitest';
import { fitWithin, shrinkImage } from './shrinkImage';

describe('shrinkImage', () => {
  it('caps the longest side and keeps the shape', () => {
    expect(fitWithin(1080, 2400, 2000)).toEqual({ width: 900, height: 2000 });
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(720, 1600, 2000)).toEqual({ width: 720, height: 1600 });
  });

  it('returns the original file when the image cannot be read', async () => {
    const file = new File(['not an image'], 'pay.png', { type: 'image/png' });
    await expect(shrinkImage(file)).resolves.toBe(file);
  });
});
