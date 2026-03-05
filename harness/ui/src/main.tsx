import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Foundation
import './styles/theme.css'
import './styles/layout.css'

// Components
import './styles/components/sidebar.css'
import './styles/components/session-item.css'
import './styles/components/profile-panel.css'
import './styles/components/session-setup.css'
import './styles/components/config-bar.css'
import './styles/components/messages.css'
import './styles/components/markdown.css'
import './styles/components/tools.css'
import './styles/components/chat-input.css'
import './styles/components/media.css'
import './styles/components/dashboard.css'
import './styles/components/permissions.css'
import './styles/components/create-profile.css'
import './styles/components/mo-logo.css'
import './styles/components/file-changes.css'

// Views
import './styles/views/login.css'
import './styles/views/profile-editor.css'
import './styles/views/mcp-editor.css'
import './styles/views/memory.css'
import './styles/views/schedules.css'
import './styles/views/git.css'

// Overrides (last — responsive)
import './styles/mobile.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
