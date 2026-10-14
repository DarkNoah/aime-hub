import { Component, type ReactNode } from 'react';

export class PluginBoundary extends Component<
  { children: ReactNode; message: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert" className="p-4 text-sm text-muted-foreground">
        {this.props.message}
      </p>
    ) : (
      this.props.children
    );
  }
}
