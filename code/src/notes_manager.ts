import * as vscode from 'vscode';
import { NoteStatus, ReviewNote, Severity } from './types';

const notesStorageKey = 'llmBuddy.notes';

export interface NoteToolEvent {
	tool: 'add_note' | 'update_note' | 'remove_note';
	noteId: number;
	scopeKey: string;
	uri: string;
	line?: number;
	message?: string;
}

export class NotesManager implements vscode.Disposable {
	private readonly notes: ReviewNote[];
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('llm-buddy');
	private readonly codeLensEmitter = new vscode.EventEmitter<void>();
	private readonly changeListener: vscode.Disposable;
	private readonly codeLensProvider: vscode.Disposable;
	private nextId: number;
	private onEdited: (scopeKey: string) => void = () => {};
	private onToolEvent: (event: NoteToolEvent) => void = () => {};

	constructor(private readonly context: Pick<vscode.ExtensionContext, 'workspaceState'>) {
		this.notes = context.workspaceState.get<ReviewNote[]>(notesStorageKey, []);
		this.nextId = this.notes.reduce((maximum, note) => Math.max(maximum, note.id), 0) + 1;
		this.changeListener = vscode.workspace.onDidChangeTextDocument((event) => this.documentChanged(event));
		this.codeLensProvider = vscode.languages.registerCodeLensProvider(
			[{ scheme: 'file' }, { scheme: 'untitled' }],
			{
				onDidChangeCodeLenses: this.codeLensEmitter.event,
				provideCodeLenses: (document) => this.codeLenses(document),
			},
		);
		this.refreshDiagnostics();
	}

	setEditedHandler(handler: (scopeKey: string) => void): void {
		this.onEdited = handler;
	}

	setToolEventHandler(handler: (event: NoteToolEvent) => void): void {
		this.onToolEvent = handler;
	}

	list(scopeKey: string): ReviewNote[] {
		return this.notes.filter((note) => note.scopeKey === scopeKey);
	}

	activeNotes(): ReviewNote[] {
		return this.notes.filter((note) => note.status === 'active');
	}

	add(scopeKey: string, uri: vscode.Uri, line: number, message: string, severity: Severity): string {
		const document = this.findDocument(uri.toString());
		if (!document) {
			return `Cannot add note; document is not open: ${uri.fsPath}`;
		}
		if (!Number.isInteger(line) || line < 1 || line > document.lineCount) {
			return `Cannot add note; line ${line} is outside the document.`;
		}
		const note: ReviewNote = {
			id: this.nextId++,
			scopeKey,
			uri: uri.toString(),
			line,
			message,
			severity,
			status: 'active',
			createdAt: Date.now(),
		};
		this.notes.push(note);
		this.refreshDiagnostics();
		this.persist();
		this.onToolEvent({ tool: 'add_note', noteId: note.id, scopeKey, uri: note.uri, line, message });
		return `Note ${note.id} added at line ${line} in ${document.uri.fsPath}.`;
	}

	update(scopeKey: string, noteId: number, message: string): string {
		const note = this.findInScope(scopeKey, noteId);
		if (!note || note.status !== 'active') {
			return `Active note ${noteId} was not found in this review scope.`;
		}
		note.message = message;
		note.editedAt = undefined;
		this.refreshDiagnostics();
		this.persist();
		this.onToolEvent({ tool: 'update_note', noteId, scopeKey, uri: note.uri, message });
		return `Note ${noteId} updated.`;
	}

	dismiss(scopeKey: string, noteId: number, reason = 'dismissed by user'): string {
		const note = this.findInScope(scopeKey, noteId);
		if (!note || note.status !== 'active') {
			return `Active note ${noteId} was not found in this review scope.`;
		}
		note.status = 'dismissed';
		note.dismissedAt = Date.now();
		note.dismissedReason = reason;
		this.refreshDiagnostics();
		this.persist();
		this.onToolEvent({ tool: 'remove_note', noteId, scopeKey, uri: note.uri });
		return `Note ${noteId} dismissed (${reason}).`;
	}

	dismissAt(uri: string, line: number): boolean {
		const note = this.notes.find((item) =>
			item.status === 'active' && item.uri === uri && item.line === line + 1,
		);
		return note ? this.dismiss(note.scopeKey, note.id).startsWith('Note ') : false;
	}

	dismissAll(): void {
		for (const note of this.notes) {
			if (note.status === 'active') {
				note.status = 'dismissed';
				note.dismissedAt = Date.now();
				note.dismissedReason = 'dismissed by user';
				this.onToolEvent({ tool: 'remove_note', noteId: note.id, scopeKey: note.scopeKey, uri: note.uri });
			}
		}
		this.refreshDiagnostics();
		this.persist();
	}

	removeScope(scopeKey: string): void {
		for (let index = this.notes.length - 1; index >= 0; index--) {
			if (this.notes[index].scopeKey === scopeKey) {
				this.notes.splice(index, 1);
			}
		}
		this.refreshDiagnostics();
		this.persist();
	}

	private findInScope(scopeKey: string, noteId: number): ReviewNote | undefined {
		return this.notes.find((note) => note.id === noteId && note.scopeKey === scopeKey);
	}

	private findDocument(uri: string): vscode.TextDocument | undefined {
		return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri);
	}

	private documentChanged(event: vscode.TextDocumentChangeEvent): void {
		const uri = event.document.uri.toString();
		const changedLineNumbers = new Set<number>();
		for (const change of event.contentChanges) {
			for (let line = change.range.start.line; line <= change.range.end.line; line++) {
				changedLineNumbers.add(line);
			}
		}
		let editedScope: string | undefined;
		for (const note of this.notes) {
			if (note.status !== 'active' || note.uri !== uri) {
				continue;
			}
			const zeroBasedLine = note.line - 1;
			if (changedLineNumbers.has(zeroBasedLine)) {
				note.editedAt = Date.now();
				editedScope = note.scopeKey;
			}
			let lineDelta = 0;
			for (const change of event.contentChanges) {
				const oldLineCount = change.range.end.line - change.range.start.line;
				const newLineCount = (change.text.match(/\n/g) ?? []).length;
				if (change.range.end.line < zeroBasedLine) {
					lineDelta += newLineCount - oldLineCount;
				}
			}
			note.line = Math.max(1, Math.min(event.document.lineCount, note.line + lineDelta));
		}
		this.refreshDiagnostics();
		this.persist();
		if (editedScope) {
			this.onEdited(editedScope);
		}
	}

	private codeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const uri = document.uri.toString();
		const lenses: vscode.CodeLens[] = [];
		for (const note of this.notes) {
			if (note.status !== 'active' || note.uri !== uri || note.line > document.lineCount) {
				continue;
			}
			const position = new vscode.Position(note.line - 1, 0);
			const range = new vscode.Range(position, position);
			lenses.push(new vscode.CodeLens(range, {
				title: `llm-buddy [${note.severity}]: ${note.message}`,
				command: 'llmBuddy.dismissNoteAt',
				arguments: [note.uri, position.line],
			}));
		}
		return lenses;
	}

	private refreshDiagnostics(): void {
		const groups = new Map<string, vscode.Diagnostic[]>();
		for (const note of this.notes) {
			if (note.status !== 'active') {
				continue;
			}
			const uri = vscode.Uri.parse(note.uri);
			const document = this.findDocument(note.uri);
			const line = Math.max(0, Math.min(note.line - 1, (document?.lineCount ?? note.line) - 1));
			const range = document
				? document.lineAt(line).range
				: new vscode.Range(line, 0, line, 1);
			const severity = note.severity === 'critical'
				? vscode.DiagnosticSeverity.Error
				: note.severity === 'significant'
					? vscode.DiagnosticSeverity.Warning
					: vscode.DiagnosticSeverity.Information;
			const diagnostic = new vscode.Diagnostic(range, note.message, severity);
			diagnostic.source = 'llm-buddy';
			const entries = groups.get(uri.toString()) ?? [];
			entries.push(diagnostic);
			groups.set(uri.toString(), entries);
		}
		this.diagnostics.clear();
		for (const [uri, entries] of groups) {
			this.diagnostics.set(vscode.Uri.parse(uri), entries);
		}
		this.codeLensEmitter.fire();
	}

	private persist(): void {
		Promise.resolve(this.context.workspaceState.update(notesStorageKey, this.notes))
			.catch((error: unknown) => console.error('llm-buddy could not persist note history:', error));
	}

	dispose(): void {
		this.changeListener.dispose();
		this.codeLensProvider.dispose();
		this.codeLensEmitter.dispose();
		this.diagnostics.dispose();
	}
}
