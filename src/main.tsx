import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { I18nProvider } from '@/i18n/provider';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import NotConfigured from '@/components/NotConfigured';
import { initializeMonitoring } from '@/lib/monitoring';
import { missingSupabaseConfig, supabaseConfigured } from '@/lib/supabase';

initializeMonitoring();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {supabaseConfigured ? (
      <I18nProvider>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </I18nProvider>
    ) : (
      <NotConfigured missing={missingSupabaseConfig} />
    )}
  </StrictMode>
);
