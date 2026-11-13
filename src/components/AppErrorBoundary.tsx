import { Component, type ReactNode } from 'react';
import { reportError } from '@/lib/monitoring';
import { translate } from '@/i18n/context';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    reportError(error);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-surface-page px-5 text-ink">
          <section className="max-w-sm space-y-4 text-center">
            <h1 className="text-xl font-bold text-ink-strong">{translate('crash.title')}</h1>
            <p className="text-sm text-ink-muted">{translate('crash.body')}</p>
            <button type="button" onClick={() => window.location.reload()} className="min-h-tap rounded-control bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-500">
              {translate('crash.reload')}
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
