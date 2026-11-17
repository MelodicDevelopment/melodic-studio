// Melodic UI, imported once
import '@melodicdev/components/button';
import '@melodicdev/components/input';
import '@melodicdev/components/textarea';
import '@melodicdev/components/checkbox';
import '@melodicdev/components/select';
import '@melodicdev/components/dialog';
import '@melodicdev/components/popover';
import '@melodicdev/components/tabs';
import '@melodicdev/components/icon';
import '@melodicdev/components/badge';
import '@melodicdev/components/spinner';
import '@melodicdev/components/tooltip';
import '@melodicdev/components/toast';

// Services (self-register)
import './services/backend.service';
import './services/repo.store';
import './services/explorer.store';
import './services/agents.store';
import './services/lsp.service';
import './services/ai.service';
import './services/host.store';

// App components
import './components/diff/diff-view.component';
import './components/toolbar/toolbar.component';
import './components/changes/changes.component';
import './components/history/history.component';
import './components/explorer/explorer.component';
import './components/editor/editor.component';
import './components/agents/agents.component';
import './components/agents/agent-session.component';
import './components/agents/worktree-banner.component';
import './components/dialogs/dialogs.component';
import './components/host/host-dialogs.component';
import './components/app/app.component';
