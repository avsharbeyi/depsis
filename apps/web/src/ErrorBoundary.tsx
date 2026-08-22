import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  message: string | null;
}

/**
 * The last thing between a rendering bug and a blank page.
 *
 * React unmounts the whole tree when a render throws, so without this the appliance's only user
 * interface becomes an empty white document with the answer in a console nobody has open. §21 asks
 * for designed error states; this is the one for the errors nothing else designed for.
 *
 * A class, because React has no hook for this — `componentDidCatch` and
 * `getDerivedStateFromError` exist only on classes, and every "hook-based error boundary" is a
 * class in a wrapper.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is what makes this diagnosable, and it exists only here — it is not on
    // the error object and not in the state.
    console.error('unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <main className="card">
        <h1>Bir şey ters gitti</h1>
        <p className="error" role="alert">
          Arayüz beklenmedik bir hatayla durdu. Verileriniz etkilenmedi — bu yalnızca bu sekmedeki
          bir çizim hatası.
        </p>
        <pre>{this.state.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>
          Yeniden yükle
        </button>
      </main>
    );
  }
}
