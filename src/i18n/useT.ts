import { useContext } from 'react';
import { I18nContext, interpolate, translate } from './context';

export function useT() {
  return useContext(I18nContext);
}

export { interpolate, translate };
