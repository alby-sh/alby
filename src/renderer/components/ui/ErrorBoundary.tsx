import { Component, type ReactNode } from 'react'
import { reportRendererError } from '../../error-reporter'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onError?: (err: Error) => void
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] caught', error, info)
    reportRendererError(error, { componentStack: info.componentStack ?? undefined })
    this.props.onError?.(error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback ?? (
        <div className="flex items-center justify-center h-full text-neutral-400 text-sm p-4 text-center">
          Terminal crashed — close this tab and try again.
        </div>
      )
    }
    return this.props.children
  }
}
