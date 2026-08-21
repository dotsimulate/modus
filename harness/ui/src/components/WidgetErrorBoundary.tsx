import { Component, type ReactNode } from "react";

type WidgetErrorBoundaryProps = {
  label: string;
  logLabel: "page widget" | "panel widget";
  children: ReactNode;
};

type WidgetErrorBoundaryState = {
  error: Error | null;
  autoRetried: boolean;
  autoRetrying: boolean;
};

export class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  private retryTimer: ReturnType<typeof window.setTimeout> | null = null;
  private hotUpdateTimer: ReturnType<typeof window.setTimeout> | null = null;

  constructor(props: WidgetErrorBoundaryProps) {
    super(props);
    this.state = { error: null, autoRetried: false, autoRetrying: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidMount() {
    import.meta.hot?.on("vite:afterUpdate", this.handleHotUpdate);
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[modus] ${this.props.logLabel} failed to render: ${this.props.label}`, error);
    if (info.componentStack) console.error(`[modus] ${this.props.logLabel} stack:`, info.componentStack);
    if (!this.state.autoRetried) {
      this.setState({ autoRetried: true, autoRetrying: true });
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null;
        this.setState({ error: null, autoRetrying: false });
      }, 250);
    }
  }

  componentWillUnmount() {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    if (this.hotUpdateTimer) window.clearTimeout(this.hotUpdateTimer);
    import.meta.hot?.off("vite:afterUpdate", this.handleHotUpdate);
  }

  private handleHotUpdate = () => {
    if (this.hotUpdateTimer) window.clearTimeout(this.hotUpdateTimer);
    this.hotUpdateTimer = window.setTimeout(() => {
      this.hotUpdateTimer = null;
      if (!this.state.error && !this.state.autoRetried) return;
      if (this.retryTimer) {
        window.clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.setState({ error: null, autoRetried: false, autoRetrying: false });
    }, 50);
  };

  private retry = () => {
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.setState({ error: null, autoRetried: false, autoRetrying: false });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-empty" style={{ padding: 12, whiteSpace: "normal", wordBreak: "break-word" }}>
        {this.props.label} couldn&apos;t render{this.state.autoRetrying ? ". Retrying..." : "."}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="sched-clear-btn" onClick={this.retry}>retry</button>
        </div>
      </div>
    );
  }
}
