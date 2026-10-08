import * as vscode from 'vscode';
import { ChangeTracker, getScopeDescription, getScopeKey } from './change_tracker';
import { createNumberedDiff, reconstructOriginal } from './diff';
import { NotesManager } from './notes_manager';
import { get_setting_or, is_severity, rank_from_severity } from './settings';
import {
	ChatMessage,
	ChangeChunk,
	LlmProvider,
	Severity,
	ToolCall,
	ToolDefinition,
	ReviewCapture,
	NoteToolEvent,
} from './types';


const reviewTools: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read a file in the current review scope, optionally restricted to line numbers.',
			parameters: {
				type: 'object',
				properties: {
					file: { type: 'string', description: 'The exact file path shown in the diff header.' },
					begin: { type: 'integer', description: 'First line to include, one-based.' },
					end: { type: 'integer', description: 'Last line to include, one-based.' },
				},
				required: ['file'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'add_note',
			description: 'Add a short note for a real problem on a changed line.',
			parameters: {
				type: 'object',
				properties: {
					file: { type: 'string' },
					line_number: { type: 'integer', description: 'One-based current line number.' },
					note: { type: 'string' },
					severity: { type: 'string', enum: ['trivial', 'significant', 'critical'] },
				},
				required: ['file', 'line_number', 'note', 'severity'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_note',
			description: 'Update the text of a previous active note that is no longer accurate.',
			parameters: {
				type: 'object',
				properties: {
					note_id: { type: 'integer' },
					note: { type: 'string' },
				},
				required: ['note_id', 'note'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'remove_note',
			description: 'Dismiss a previous active note that is no longer relevant.',
			parameters: {
				type: 'object',
				properties: { note_id: { type: 'integer' } },
				required: ['note_id'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'end',
			description: 'Call when the review is complete and there are no more notes to add, update, or remove.',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
		},
	},
];

type ShowMessage = "show_messages" | "hide_messages";

export type ReviewFunction = (uri: vscode.Uri, showMessages : ShowMessage) => Promise<ReviewCapture | undefined>;

type CaptureHandler = (capture: ReviewCapture) => void;

export class ReviewService {
	private readonly activeScopes = new Set<string>();
	private readonly fixTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly captures = new Map<string, ReviewCapture>();

	constructor(
		private readonly tracker: ChangeTracker,
		private readonly notes: NotesManager,
		private readonly providerFactory: () => Promise<LlmProvider>,
	) {
		this.notes.setToolEventHandler((event) => this.captureTool(event));
	}

	async review(uri: vscode.Uri, showMessages: ShowMessage, captureHandler: CaptureHandler | undefined): Promise<ReviewCapture | undefined> {
		console.log("starting review");
		const scopeKey = getScopeKey(uri);
		if (this.activeScopes.has(scopeKey)) {
			console.log("missing scope key");
			return undefined;
		}
		const startedAt = Date.now();
		const changes = this.tracker.getChanges(scopeKey);
		const reviewedRevision = this.tracker.getLatestRevision(scopeKey);
		if (changes.length === 0) {
			if (showMessages === 'show_messages') {
				vscode.window.showInformationMessage('llm-buddy: no new edits to review in this scope.');
			}
			return undefined;
		}
		const diff = this.formatChanges(changes);
		if (!diff.trim()) {
			this.tracker.markReviewed(scopeKey, reviewedRevision);
			if (showMessages === 'show_messages') {
				vscode.window.showInformationMessage('llm-buddy: no net changes to review.');
			}
			return undefined;
		}

		this.activeScopes.add(scopeKey);
		const capture: ReviewCapture = {
			scopeKey,
			provider: '',
			startedAt,
			diff,
			toolEvents: [],
			responses: [],
			notes: [],
			files: [...new Map(changes.map((change) => [change.uri, {
				uri: change.uri,
				file: change.fileName,
				language: change.languageId,
			}])).values()],
		};
		this.captures.set(scopeKey, capture);
		try {
			const provider = await this.providerFactory();
			capture.provider = get_setting_or('provider', 'openai-compatible');
			await this.runConversation(provider, scopeKey, changes, diff, reviewedRevision, capture);
		} catch (error) {
			if (showMessages === 'hide_messages') {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`llm-buddy review failed: ${message}`);
		} finally {
			this.activeScopes.delete(scopeKey);
			this.finishCapture(capture, captureHandler);
		}
		return capture;
	}

	private async runConversation(
		provider: LlmProvider,
		scopeKey: string,
		changes: ChangeChunk[],
		diff: string,
		reviewedRevision: number,
		capture: ReviewCapture,
	): Promise<void> {
		const messages: ChatMessage[] = [
			{ role: 'system', content: this.instructions(scopeKey) },
			{
				role: 'user',
				content: `${diff}${this.formatPreviousNotes(scopeKey)}`,
			},
		];
		const maximumIterations = get_setting_or('maxIterations', 8);
		for (let iteration = 0; iteration < maximumIterations; iteration++) {
			const response = await provider.complete(messages, reviewTools);
			capture.responses.push(response.message);
			messages.push(response.message);
			const calls = response.message.tool_calls ?? [];
			if (calls.length === 0) {
				if (response.message.content) {
					messages.push({
						role: 'user',
						content: 'Continue the review. Use the available tools to add, update, or remove notes, then call end.',
					});
				}
				continue;
			}

			let ended = false;
			for (const call of calls) {
				const result = await this.executeTool(call, scopeKey, changes);
				messages.push({ role: 'tool', tool_call_id: call.id, content: result });
				if (call.function.name === 'end') {
					ended = true;
				}
			}
			if (ended) {
				this.tracker.markReviewed(scopeKey, reviewedRevision);
				return;
			}
		}
		throw new Error(`Review did not finish within ${maximumIterations} tool iterations.`);
	}

	private async executeTool(
		call: ToolCall,
		scopeKey: string,
		changes: ChangeChunk[],
	): Promise<string> {
		let args: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(call.function.arguments || '{}');
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return 'Tool arguments must be a JSON object.';
			}
			args = parsed as Record<string, unknown>;
		} catch {
			return 'Tool arguments were not valid JSON.';
		}

		switch (call.function.name) {
			case 'read_file':
				return this.readFile(args, scopeKey, changes);
			case 'add_note':
				return this.addNote(args, scopeKey, changes);
			case 'update_note':
				return this.updateNote(args, scopeKey);
			case 'remove_note':
				return this.removeNote(args, scopeKey);
			case 'end':
				return 'Review complete.';
			default:
				return `Unknown tool: ${call.function.name}`;
		}
	}

	private readFile(
		args: Record<string, unknown>,
		scopeKey: string,
		changes: ChangeChunk[],
	): string {
		const chunk = this.findChunk(args.file, scopeKey, changes);
		if (!chunk) {
			return 'File is not part of this review scope.';
		}
		const document = this.tracker.getOpenDocument(chunk.uri);
		if (!document) {
			return 'File is no longer open; it cannot be read in this review.';
		}
		const begin = validLine(args.begin, 1);
		const end = validLine(args.end, document.lineCount);
		if (begin < 1 || end < begin) {
			return 'Requested line range is invalid.';
		}
		const first = Math.min(begin - 1, document.lineCount - 1);
		const last = Math.min(end, document.lineCount);
		return document.getText(new vscode.Range(first, 0, last, 0))
			.split(/\r?\n/)
			.map((line, index) => `${first + index + 1}: ${line}`)
			.join('\n');
	}

	private addNote(
		args: Record<string, unknown>,
		scopeKey: string,
		changes: ChangeChunk[],
	): string {
		if (typeof args.note !== 'string' || !args.note.trim()) {
			return 'A non-empty note is required.';
		}
		if (typeof args.line_number !== 'number' || !Number.isInteger(args.line_number)) {
			return 'line_number must be an integer.';
		}
		if (!is_severity(args.severity)) {
			return 'severity must be trivial, significant, or critical.';
		}
		const chunk = this.findChunk(args.file, scopeKey, changes);
		if (!chunk) {
			return 'File is not part of this review scope.';
		}
		const minimum = get_setting_or<Severity>('detectMinimum', 'significant');
		if (!is_severity(minimum)) {
			return 'llmBuddy.detectMinimum must be trivial, significant, or critical.';
		}
		if (rank_from_severity(args.severity) < rank_from_severity(minimum)) {
			if (get_setting_or('fixUnreported', false)) {
				return this.scheduleFix(chunk.uri, args.line_number, args.note);
			}
			return 'Ignoring note below the configured minimum severity.';
		}
		return this.notes.add(scopeKey, vscode.Uri.parse(chunk.uri), args.line_number, args.note, args.severity);
	}

	private updateNote(args: Record<string, unknown>, scopeKey: string): string {
		if (typeof args.note_id !== 'number' || !Number.isInteger(args.note_id) || typeof args.note !== 'string') {
			return 'note_id must be an integer and note must be a string.';
		}
		return this.notes.update(scopeKey, args.note_id, args.note);
	}

	private removeNote(args: Record<string, unknown>, scopeKey: string): string {
		if (typeof args.note_id !== 'number' || !Number.isInteger(args.note_id)) {
			return 'note_id must be an integer.';
		}
		return this.notes.dismiss(scopeKey, args.note_id, 'removed by agent');
	}

	private findChunk(
		file: unknown,
		scopeKey: string,
		changes: ChangeChunk[],
	): ChangeChunk | undefined {
		if (typeof file !== 'string') {
			return undefined;
		}
		return changes.find((chunk) =>
			chunk.scopeKey === scopeKey && (chunk.fileName === file || vscode.Uri.parse(chunk.uri).fsPath === file),
		);
	}

	private formatChanges(changes: ChangeChunk[]): string {
		const documents = new Map<string, ChangeChunk[]>();
		for (const change of changes) {
			const entries = documents.get(change.uri) ?? [];
			entries.push(change);
			documents.set(change.uri, entries);
		}
		const sections: string[] = [];
		for (const [uri, entries] of documents) {
			const first = entries[0];
			const document = this.tracker.getOpenDocument(uri);
			if (!document) {
				continue;
			}
			const currentText = document.getText();
			const originalText = reconstructOriginal(currentText, entries);
			const diff = createNumberedDiff(originalText, currentText).text;
			if (!diff) {
				continue;
			}
			const editor = vscode.window.activeTextEditor;
			const cursorLine = editor?.document.uri.toString() === uri ? editor.selection.active.line + 1 : 'unknown';
			sections.push(
				`=== File: ${first.fileName}  Language: ${document.languageId}  Project: ${getScopeDescription(document.uri)}  Cursor: line ${cursorLine} ===\n${diff}`,
			);
		}
		return sections.join('\n\n');
	}

	private formatPreviousNotes(scopeKey: string): string {
		const notes = this.notes.list(scopeKey);
		if (notes.length === 0) {
			return '';
		}
		return '\n\nPrevious notes in this scope, newest first. Active notes are visible; dismissed notes remain in history to avoid repeating stale feedback.\n'
			+ notes.slice().reverse().map((note) =>
				`- note_id ${note.id} [${note.status}] ${vscode.Uri.parse(note.uri).fsPath}:${note.line} (${note.severity}): ${note.message}`
				+ (note.status === 'dismissed' ? ` (dismissed: ${note.dismissedReason ?? 'unknown'})` : '')
				+ (note.editedAt ? ' (annotated line changed; re-evaluate this note)' : ''),
			).join('\n');
	}

	private instructions(scopeKey: string): string {
		return `You review only the user's recent changes in VS Code scope ${scopeKey}. Report concrete problems in changed code or prose, not hypothetical concerns. Do not comment on incomplete work near the cursor. Removed lines are labeled "old" and are not current locations. Use read_file when context is needed. Add only brief, actionable notes on current line numbers. Use update_note or remove_note for previous notes when appropriate. Call end when finished.`;
	}

	private scheduleFix(uri: string, line: number, problem: string): string {
		const key = `${uri}:${line}`;
		const oldTimer = this.fixTimers.get(key);
		if (oldTimer) {
			clearTimeout(oldTimer);
		}
		const fix_idle_delay = Math.max(0, get_setting_or('fixIdleDelay', 3));
		const timer = setTimeout(() => {
			this.fixTimers.delete(key);
			this.runFix(uri, line, problem).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`llm-buddy automatic fix failed: ${message}`);
			});
		}, fix_idle_delay * 1000);
		this.fixTimers.set(key, timer);
		return `Automatic fix scheduled after ${fix_idle_delay} seconds of idle time.`;
	}

	private async runFix(uri: string, lineNumber: number, problem: string): Promise<void> {
		const document = this.tracker.getOpenDocument(uri);
		if (!document || lineNumber < 1 || lineNumber > document.lineCount) {
			return;
		}
		const version = document.version;
		const first = Math.max(0, lineNumber - 2);
		const last = Math.min(document.lineCount, lineNumber + 1);
		const range = new vscode.Range(first, 0, last, 0);
		const original = document.getText(range);
		const provider = await this.providerFactory();
		const tools: ToolDefinition[] = [{
			type: 'function',
			function: {
				name: 'replace_content',
				description: 'Replace the supplied content with a corrected version.',
				parameters: {
					type: 'object',
					properties: { new_content: { type: 'string' } },
					required: ['new_content'],
					additionalProperties: false,
				},
			},
		}];
		const response = await provider.complete([{
			role: 'user',
			content: `A detected issue needs a small fix. Problem: ${problem}\nLanguage: ${document.languageId}\nContent to fix:\n${original}`,
		}], tools);
		const call = response.message.tool_calls?.find((tool) => tool.function.name === 'replace_content');
		if (!call) {
			return;
		}
		const args: unknown = JSON.parse(call.function.arguments);
		if (!args || typeof args !== 'object' || !('new_content' in args) || typeof args.new_content !== 'string') {
			throw new Error('Provider returned an invalid replacement.');
		}
		const currentDocument = this.tracker.getOpenDocument(uri);
		if (!currentDocument || currentDocument.version !== version || currentDocument.getText(range) !== original) {
			vscode.window.showInformationMessage('llm-buddy skipped an automatic fix because the document changed.');
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(currentDocument.uri, range, args.new_content);
		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error('VS Code declined the automatic edit.');
		}
	}

	private captureTool(event: NoteToolEvent): void {
		const capture = this.captures.get(event.scopeKey);
		if (capture) {
			capture.toolEvents.push(event);
		}
	}

	private finishCapture(capture: ReviewCapture, captureHandler : CaptureHandler | undefined): void {
		capture.finishedAt = Date.now();
		capture.notes = this.notes.list(capture.scopeKey)
			.filter((note) => note.status === 'active')
			.map((note) => ({
				id: note.id,
				uri: note.uri,
				line: note.line,
				message: note.message,
				severity: note.severity,
			}));
		captureHandler?.(capture);
		this.captures.delete(capture.scopeKey);
	}

	dispose(): void {
		for (const timer of this.fixTimers.values()) {
			clearTimeout(timer);
		}
		this.fixTimers.clear();
	}
}

function validLine(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}
