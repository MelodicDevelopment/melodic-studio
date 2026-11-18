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
import './services/updates.service';
import './services/terminal.store';
import './services/host.store';
import './services/ai-features.store';

// App components
import './components/diff/diff-view.component';
import './components/repo-tabs/repo-tabs.component';
import './components/updates/updates.component';
import './components/toolbar/toolbar.component';
import './components/changes/changes.component';
import './components/history/history.component';
import './components/explorer/explorer.component';
import './components/editor/editor.component';
import './components/agents/agents.component';
import './components/workspace/workspace.component';
import './components/workspace/workspace-button.component';
import './components/agents/agent-session.component';
import './components/agents/worktree-banner.component';
import './components/init/init-repo.component';
import './components/terminal/terminal.component';
import './components/ai/ai-commit.component';
import './components/ai/ai-review-banner.component';
import './components/ai/ai-panel.component';
import './components/ai/ai-review-diff.component';
import './components/ai/ai-proposal.component';
import './components/settings/language-servers.component';
import './components/settings/editor-settings.component';
import './components/agents/ask.component';
import './components/agents/attempts.component';
import './components/agents/agent-board.component';
import './components/dialogs/dialogs.component';
import './components/dialogs/git-ops.component';
import './components/host/host-dialogs.component';
import './components/app/app.component';
