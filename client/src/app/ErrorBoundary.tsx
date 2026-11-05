import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  onBack: () => void;
  children: ReactNode;
}

/** Keeps a rendering crash in the game screen from blanking the whole app. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] game screen crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 bg-slate-950 p-6 text-center text-slate-100"
      >
        <h1 className="text-2xl font-bold text-rose-300">Something went wrong</h1>
        <p className="text-sm text-slate-400">{this.state.error.message}</p>
        <button
          type="button"
          onClick={this.props.onBack}
          className="rounded-lg bg-amber-400 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-300"
        >
          Back to menu
        </button>
      </div>
    );
  }
}
