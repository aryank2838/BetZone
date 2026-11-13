import { Home, ReceiptText, User, Wallet } from 'lucide-react';
import type { NavView } from '@/lib/useNav';
import { useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

export type TabView = Extract<NavView, 'home' | 'mybets' | 'balance' | 'settings'>;

const TABS: { view: TabView; label: TranslationKey; icon: typeof Home }[] = [
  { view: 'home', label: 'nav.home', icon: Home },
  { view: 'mybets', label: 'nav.myBets', icon: ReceiptText },
  { view: 'balance', label: 'nav.money', icon: Wallet },
  { view: 'settings', label: 'nav.account', icon: User },
];

/** Fixed bottom tab bar for the four main areas of the app. */
export default function BottomNav({ active, onNavigate }: { active: TabView; onNavigate: (view: TabView) => void }) {
  const { t } = useT();
  return (
    <nav
      aria-label={t('nav.label')}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-surface-border bg-surface-page/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl"
    >
      <ul className="mx-auto grid max-w-2xl grid-cols-4">
        {TABS.map(({ view, label, icon: Icon }) => {
          const current = view === active;
          return (
            <li key={view}>
              <button
                type="button"
                onClick={() => onNavigate(view)}
                aria-current={current ? 'page' : undefined}
                className={`flex min-h-[56px] w-full flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
                  current ? 'text-brand-400' : 'text-ink-muted hover:text-ink-soft'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {t(label)}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

