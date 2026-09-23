import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Foundation
import './styles/colors.css'
import './styles/theme.css'
import './styles/layout.css'

// Components
import './styles/components/sidebar.css'
import './styles/components/session-item.css'
import './styles/components/profile-panel.css'
import './styles/components/session-setup.css'
import './styles/components/search-dropdown.css'
import './styles/components/about.css'
import './styles/components/config-bar.css'
import './styles/components/messages.css'
import './styles/components/markdown.css'
import './styles/components/tools.css'
import './styles/components/compact-disclosure.css'
import './styles/components/chat-input.css'
import './styles/components/media.css'
import './styles/components/dashboard.css'
import './styles/components/widgets.css'
import './styles/components/project-setup.css'
import './styles/components/modus-prompt.css'
import './styles/components/mini-session.css'
import './styles/components/permissions.css'
import './styles/components/create-profile.css'
import './styles/components/user-settings.css'
import './styles/components/update-banner.css'
import './styles/components/mo-logo.css'
import './styles/components/file-changes.css'
import './styles/components/file-viewer.css'
import './styles/components/floating-window.css'
import './styles/components/session-window.css'
import './styles/components/queued-message.css'
import './styles/components/chat-settings.css'
import './styles/components/stats-widget.css'
import './styles/components/account-widget.css'
import './styles/components/claude-pricing-widget.css'
import './styles/components/custom-select.css'
import './styles/components/date-time-field.css'
import './styles/components/inline-tabs.css'
import './styles/components/prompt-composer.css'
import './styles/components/project-theme-widget.css'
import './styles/components/provider-usage-widget.css'
import './styles/components/deep-analytics-widget.css'
import './styles/components/time-axis.css'
import './styles/components/prompt-picker.css'
import './styles/components/composer-move-form.css'
import './styles/components/missions.css'
import './styles/components/mission-graph-widget.css'
import './styles/components/panels.css'
import './styles/components/session-info-widget.css'
import './styles/components/session-control-widget.css'
import './styles/components/file-browser.css'
import './styles/components/mini-float.css'
import './styles/components/agent-portal.css'
import './styles/components/pinboard.css'
import './styles/components/moves-widget.css'
import './styles/components/file-picker.css'
import './styles/components/hints-launcher-widget.css'
import './styles/components/notes-widget.css'
import './styles/components/pages-browser-widget.css'
import './styles/components/page-picker.css'
import './styles/components/activity.css'
import './styles/components/terminal.css'
import './styles/components/terminal-widget.css'
import './styles/components/processes-widget.css'
import './styles/components/context-menu.css'
import './styles/components/provider-status-widget.css'
import './styles/components/profile-card-widget.css'
import './styles/components/default-agent-widget.css'
import './styles/components/config-inspector-widget.css'
import './styles/components/session-transition.css'
import './styles/components/session-history-widget.css'
import './styles/components/session-streams-widget.css'
import './styles/components/extensions-widget.css'
import './styles/components/widget-picker.css'
import './styles/components/chat-scroll-spine.css'
import './styles/components/session-turn.css'
import './styles/components/conversation-host.css'
import './styles/components/paste-block.css'
import './styles/components/backend-targets.css'
import './styles/components/docs-widget.css'

// Views
import './styles/views/login.css'
import './styles/views/profiles.css'
import './styles/views/profile-editor.css'
import './styles/views/mcp-editor.css'
import './styles/views/memory.css'
import './styles/views/actions.css'
import './styles/views/git.css'
import './styles/views/web.css'
import './styles/views/trace.css'
import './styles/views/editor.css'

// Overrides (last — responsive)
import './styles/mobile.css'
import { initFavicon } from './favicon'
import {
  backendIdentityChanged,
  EXTERNAL_LOCAL_BACKEND_TARGET,
  getActiveBackendTarget,
  inspectBackendTarget,
  isDesktopClient,
  LOCAL_BACKEND_TARGET,
  managedVaultBackendTarget,
  probeBackendTarget,
  rememberBackendConnected,
  targetSearchParams,
  type SavedBackendTarget,
} from './backend-targets'
import {
  acknowledgeManagedDesktopTarget,
  bindManagedDesktopTarget,
  bootstrapDesktop,
  isTauriRuntime,
  type DesktopBootstrapResponse,
  type DesktopBootstrapMode,
} from './desktopBridge'
import { BACKEND_TARGET, configureBackendTarget } from './backendTarget'
import { configureModusClient, modus } from './modusClient'

initFavicon()

const LOCAL_PORTS = [3777, 3778, 3779, 3780, 3781] as const

async function probeLocalBackend(port: number): Promise<string | null> {
  const base = `http://127.0.0.1:${port}`
  return await probeBackendTarget(base, 900) ? base : null
}

async function discoverLocalBackend(): Promise<string | null> {
  const results = await Promise.all(LOCAL_PORTS.map(probeLocalBackend))
  return results.find((result): result is string => !!result) ?? null
}

async function renderConnectionError(root: ReturnType<typeof createRoot>, message: string) {
  // Keep backendTarget.ts unloaded until the launch query has been finalized.
  const { BackendConnectionScreen } = await import('./components/BackendTargetManager')
  root.render(<BackendConnectionScreen message={message} />)
}

async function bootstrap() {
  const root = createRoot(document.getElementById('root')!)
  let params = new URLSearchParams(location.search)
  const desktopClient = isDesktopClient(location.search, location.origin)
  const nativeDesktop = isTauriRuntime() || params.get('modusDesktop') === '1'
  let managedDesktop: DesktopBootstrapResponse | null = null

  if (nativeDesktop) {
    const preferred = getActiveBackendTarget()
    const queryMode = params.get('modusTargetMode')
    let requestedMode: DesktopBootstrapMode = preferred.mode === 'remote' ? 'remote' : 'managed-local'
    if (params.get('modusDiscover') === 'external' || queryMode === 'external-local') {
      requestedMode = 'external-local'
    } else if (queryMode === 'remote' || queryMode === 'managed-local') {
      requestedMode = queryMode
    }
    const requestedUrl = requestedMode === 'remote'
      ? (preferred.mode === 'remote' ? preferred.url : params.get('modusTarget') ?? undefined)
      : undefined
    const requestedVault = requestedMode === 'managed-local'
      ? params.get('modusVault') ?? preferred.vaultSlug ?? undefined
      : undefined
    try {
      const response = await bootstrapDesktop(requestedMode, requestedUrl, requestedVault)
      if (response.mode === 'managed-local') {
        await bindManagedDesktopTarget(response)
        managedDesktop = response
        params.delete('modusDiscover')
        params.set('modusTarget', response.apiBase)
        params.set('modusTargetId', response.targetId)
        params.set('modusTargetMode', 'managed-local')
        params.set('modusTargetLabel', response.label)
        if (requestedVault) params.set('modusVault', requestedVault)
        else params.delete('modusVault')
      } else if (response.mode === 'remote') {
        params.delete('modusDiscover')
        params.set('modusTarget', response.apiBase)
        params.set('modusTargetId', preferred.mode === 'remote' ? preferred.id : response.targetId)
        params.set('modusTargetMode', 'remote')
        params.set('modusTargetLabel', preferred.mode === 'remote' ? preferred.label : response.label)
        params.delete('modusVault')
      } else {
        params.delete('modusTarget')
        params.set('modusDiscover', 'external')
        params.set('modusTargetMode', 'external-local')
        params.delete('modusVault')
      }
      history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await renderConnectionError(root, `Modus could not prepare the selected desktop backend: ${message}`)
      return
    }
  }

  if ((params.get('modusDiscover') === 'external' || (!nativeDesktop && params.get('modusDiscover') === 'local')) && !params.has('modusTarget')) {
    const preferred = getActiveBackendTarget()
    if (!nativeDesktop && preferred.mode === 'remote' && preferred.url) {
      params = targetSearchParams(preferred, location.search)
    } else {
      const backend = await discoverLocalBackend()
      if (!backend) {
        await renderConnectionError(root, 'No local daemon was found on ports 3777–3781. Start Modus here or connect to another computer.')
        return
      }
      params.delete('modusDiscover')
      params.set('modusTarget', backend)
      params.set('modusTargetId', EXTERNAL_LOCAL_BACKEND_TARGET.id)
      params.set('modusTargetMode', 'external-local')
      params.set('modusTargetLabel', `Development daemon · ${new URL(backend).port}`)
    }
    history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`)
  }

  if (desktopClient) {
    const apiBase = params.get('modusTarget') ?? ''
    const probe = apiBase ? await inspectBackendTarget(apiBase) : null
    if (!apiBase || !probe) {
      const label = params.get('modusTargetLabel') || (apiBase ? new URL(apiBase).host : 'selected backend')
      await renderConnectionError(root, `Could not connect to ${label}. Nothing was changed on that daemon.`)
      return
    }
    const id = params.get('modusTargetId') || `remote:${new URL(apiBase).origin}`
    const preferred = getActiveBackendTarget()
    if (preferred.id === id && backendIdentityChanged(preferred.backendId, probe.backendId)) {
      await renderConnectionError(root, `Backend identity changed for ${preferred.label}. Forget and add it again only if that replacement was intentional.`)
      return
    }
    const targetMode = params.get('modusTargetMode')
    const connected: SavedBackendTarget = id === 'local'
      ? LOCAL_BACKEND_TARGET
      : id === 'external-local'
        ? EXTERNAL_LOCAL_BACKEND_TARGET
        : targetMode === 'managed-local' && params.get('modusVault')
          ? {
            ...managedVaultBackendTarget(
              params.get('modusVault')!,
              params.get('modusTargetLabel') || params.get('modusVault')!,
            ),
            url: apiBase,
            ...(probe.backendId ? { backendId: probe.backendId } : {}),
          }
        : {
          id,
          label: params.get('modusTargetLabel') || new URL(apiBase).host,
          mode: targetMode === 'remote' ? 'remote' : 'external-local',
          url: apiBase,
          ...(probe.backendId ? { backendId: probe.backendId } : {}),
          ...(preferred.id === id ? { lastConnectedAt: preferred.lastConnectedAt } : {}),
        }
    rememberBackendConnected(connected)
  }

  // Explicitly rebind after discovery. Rollup can hoist shared modules into the
  // entry chunk even when App is dynamically imported, so import order alone
  // cannot protect the managed runtime port and credential namespace.
  configureBackendTarget({
    search: `?${params.toString()}`,
    envUrl: import.meta.env.VITE_API_URL || '',
    pageOrigin: location.origin,
  })
  configureModusClient()
  if (managedDesktop) {
    try {
      if (BACKEND_TARGET.id !== managedDesktop.targetId
        || BACKEND_TARGET.apiBase !== managedDesktop.apiBase
        || modus.baseUrl !== managedDesktop.apiBase) {
        throw new Error('the UI client did not bind to the supervisor-provided backend')
      }
      if (await modus.checkToken() !== 'browser') {
        throw new Error('the managed backend did not confirm a browser session')
      }
      await acknowledgeManagedDesktopTarget(managedDesktop)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await renderConnectionError(root, `Modus could not bind the desktop UI to its managed backend: ${message}`)
      return
    }
  }

  const { default: App } = await import('./App')
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
