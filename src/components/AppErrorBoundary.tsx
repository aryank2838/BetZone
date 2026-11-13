import { Component, type ReactNode } from 'react';
import { reportError } from '@/lib/monitoring';

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
        <main className="flex min-h-screen items-center justify-center bg-slate-950 px-5 text-slate-100">
          <section className="max-w-sm space-y-4 text-center">
            <h1 className="text-xl font-bold">Something went wrong</h1>
            <p className="text-sm text-slate-400">The app hit an unexpected error. Reload to try again.</p>
            <button type="button" onClick={() => window.location.reload()} className="min-h-11 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white">
              Reload
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
