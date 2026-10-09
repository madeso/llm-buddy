import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChangeTracker, getScopeKey } from '../change_tracker';
import { NotesManager } from '../notes_manager';
import { add_tool_event, destory_timers, run_review, TimeoutHandle } from '../review_service';
import { ChatMessage, LlmProvider, ReviewCapture, ToolDefinition } from '../types';

suite('Review service', () => {
	test('runs note tools and marks a completed review as reviewed', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'old value\n' });
		const tracker = new ChangeTracker(180);
		const values = new Map<string, unknown>();
		const workspaceState: vscode.Memento = {
			keys: () => [...values.keys()],
			get: <T>(key: string, defaultValue?: T): T | undefined =>
				values.has(key) ? values.get(key) as T : defaultValue,
			update: async (key, value) => {
				values.set(key, value);
			},
		};
		const notes_manager = new NotesManager({ workspaceState });
		let responseIndex = 0;
		const provider: LlmProvider = {
			async complete(_messages: ChatMessage[], _tools: ToolDefinition[]) {
				const toolCall = responseIndex++ === 0
					? {
						id: 'add-1',
						type: 'function' as const,
						function: {
							name: 'add_note',
							arguments: JSON.stringify({
								file: document.uri.fsPath,
								line_number: 1,
								note: 'The value is incorrect.',
								severity: 'significant',
							}),
						},
					}
					: {
						id: 'end-1',
						type: 'function' as const,
						function: { name: 'end', arguments: '{}' },
					};
				return {
					message: { role: 'assistant', content: null, tool_calls: [toolCall] },
				};
			},
		};

		const activeScopes = new Set<string>();
		const fixTimers = new Map<string, TimeoutHandle>();
		const captures = new Map<string, ReviewCapture>();
		notes_manager.setToolEventHandler((event) => {
			add_tool_event(captures, event);
		});

		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(0, 0, 0, 3), 'new');
		try {
			assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
			const capture = await run_review(activeScopes, captures, tracker, notes_manager, fixTimers, document.uri, "hide_messages", async () => provider, undefined);
			assert.ok(capture);
			assert.strictEqual(capture.responses.length, 2);
			assert.strictEqual(capture.toolEvents[0].tool, 'add_note');
			assert.strictEqual(notes_manager.list(getScopeKey(document.uri))[0].message, 'The value is incorrect.');
			assert.strictEqual(tracker.getChanges(getScopeKey(document.uri)).length, 0);
		} finally {
			destory_timers(fixTimers);
			notes_manager.dispose();
			tracker.dispose();
		}
	});
});
