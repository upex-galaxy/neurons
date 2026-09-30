#!/usr/bin/env node
// Emits a settings JSON that registers an http hook for every observable event.
// Usage: node scripts/probe/make-settings.mjs <port> [--bash-edit-diff] > probe-settings.json
const port = Number(process.argv[2] ?? 7788);
const events = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionDenied', 'SubagentStart', 'SubagentStop', 'InstructionsLoaded', 'Stop',
  'StopFailure', 'SessionEnd', 'PreCompact', 'PostCompact', 'Notification', 'CwdChanged',
];
const hook = { type: 'http', url: `http://127.0.0.1:${port}/hook?src=probe`, timeout: 2 };
const settings = { hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [hook] }]])) };
if (process.argv.includes('--bash-edit-diff')) settings.bashEditDiffEnabled = true;
process.stdout.write(JSON.stringify(settings, null, 2) + '\n');
