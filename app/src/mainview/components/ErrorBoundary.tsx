import { Component, type ErrorInfo, type ReactNode } from "react";

/** Contains a render crash to one region instead of white-screening the whole
 *  app. One malformed item (e.g. an unknown artifactType → undefined icon)
 *  otherwise takes down the entire tree; here it degrades to an inline notice
 *  the rest of the UI survives. */
export class ErrorBoundary extends Component<
  { label: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[${this.props.label}] render error:`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/8 p-4 text-sm">
          <p className="font-medium text-destructive">
            Something went wrong in {this.props.label}.
          </p>
          <p className="mt-1 text-muted-foreground break-words">
            {this.state.error.message}
          </p>
          <button
            type="button"
            className="mt-3 text-xs text-brand hover:underline"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
