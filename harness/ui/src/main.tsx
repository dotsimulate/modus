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
import './styles/components/config-bar.css'
import './styles/components/messages.css'
import './styles/components/markdown.css'
import './styles/components/tools.css'
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
import './styles/components/project-theme-widget.css'
import './styles/components/prompt-picker.css'

// Views
import './styles/views/login.css'
import './styles/views/profiles.css'
import './styles/views/profile-editor.css'
import './styles/views/mcp-editor.css'
import './styles/views/memory.css'
import './styles/views/actions.css'
import './styles/views/git.css'

// Overrides (last — responsive)
import './styles/mobile.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
