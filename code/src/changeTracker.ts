import * as vscode from 'vscode';
import { ChangeChunk } from './types';

const maximumChunksPerScope = 200;

interface ChangedRegion {
	startOffset: number;
	originalText: string;
	currentText: string;
}

export function getScopeKey(uri: vscode.Uri): string {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	return folder ? `workspace:${folder.uri.toString()}` : `document:${uri.toString()}`;
}

export function getScopeDescription(uri: vscode.Uri): string {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	return folder?.name ?? uri.fsPath;
}

export class ChangeTracker implements vscode.Disposable {
	private readonly chunks = new Map<string, ChangeChunk[]>();
	private readonly snapshots = new Map<string, string>();
	private readonly lastReviewed = new Map<string, number>();
	private readonly disposable: vscode.Disposable;
	private nextRevision = 1;

	constructor(private readonly coalesceWindowSeconds: number) {
		for (const document of vscode.workspace.textDocuments) {
			this.seedDocument(document);
		}
		this.disposable = vscode.Disposable.from(
			vscode.workspace.onDidChangeTextDocument((event) => this.record(event)),
			vscode.workspace.onDidOpenTextDocument((document) => this.seedDocument(document)),
			vscode.workspace.onDidCloseTextDocument((document) => this.forgetDocument(document.uri.toString())),
		);
	}

	seedDocument(document: vscode.TextDocument, text = document.getText()): void {
		this.snapshots.set(document.uri.toString(), text);
	}

	private record(event: vscode.TextDocumentChangeEvent): void {
		if (event.contentChanges.length === 0 || event.document.isClosed) {
			return;
		}
		const uri = event.document.uri.toString();
		const currentText = event.document.getText();
		const previousText = this.snapshots.get(uri);
		this.snapshots.set(uri, currentText);
		if (previousText === undefined || previousText === currentText) {
			return;
		}
		const region = changedRegion(previousText, currentText);
		if (!region) {
			return;
		}

		const now = Date.now();
		const scopeKey = getScopeKey(event.document.uri);
		const entries = this.chunks.get(scopeKey) ?? [];
		const previousChunk = [...entries].reverse().find((chunk) => chunk.uri === uri);
		if (previousChunk && now - previousChunk.lastChangedAt <= this.coalesceWindowSeconds * 1000) {
			const merged = mergeRegion(previousChunk, region);
			if (merged) {
				previousChunk.startOffset = merged.startOffset;
				previousChunk.originalText = merged.originalText;
				previousChunk.currentText = merged.currentText;
				previousChunk.lastChangedAt = now;
				previousChunk.revision = this.nextRevision++;
				previousChunk.languageId = event.document.languageId;
				return;
			}
		}
		entries.push({
			uri,
			scopeKey,
			fileName: event.document.uri.fsPath || event.document.uri.toString(),
			languageId: event.document.languageId,
			startOffset: region.startOffset,
			originalText: region.originalText,
			currentText: region.currentText,
			revision: this.nextRevision++,
			startedAt: now,
			lastChangedAt: now,
		});
		if (entries.length > maximumChunksPerScope) {
			entries.splice(0, entries.length - maximumChunksPerScope);
		}
		this.chunks.set(scopeKey, entries);
	}

	private forgetDocument(uri: string): void {
		this.snapshots.delete(uri);
		for (const [scopeKey, entries] of this.chunks) {
			const remaining = entries.filter((entry) => entry.uri !== uri);
			if (remaining.length === 0) {
				this.chunks.delete(scopeKey);
			} else if (remaining.length !== entries.length) {
				this.chunks.set(scopeKey, remaining);
			}
		}
	}

	getChanges(scopeKey: string, since?: number): ChangeChunk[] {
		const reviewedRevision = this.lastReviewed.get(scopeKey) ?? 0;
		return (this.chunks.get(scopeKey) ?? [])
			.filter((chunk) => since === undefined
				? chunk.revision > reviewedRevision
				: chunk.lastChangedAt >= since)
			.map((chunk) => ({ ...chunk }));
	}

	getOpenDocument(uri: string): vscode.TextDocument | undefined {
		return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri);
	}

	getLatestRevision(scopeKey: string): number {
		return Math.max(0, ...(this.chunks.get(scopeKey) ?? []).map((chunk) => chunk.revision));
	}

	markReviewed(scopeKey: string, revision: number): void {
		this.lastReviewed.set(scopeKey, revision);
	}

	clearHistory(): void {
		this.chunks.clear();
		this.lastReviewed.clear();
		this.nextRevision = 1;
		this.snapshots.clear();
		for (const document of vscode.workspace.textDocuments) {
			this.seedDocument(document);
		}
	}

	removeScope(scopeKey: string): void {
		const entries = this.chunks.get(scopeKey) ?? [];
		for (const entry of entries) {
			this.snapshots.delete(entry.uri);
		}
		this.chunks.delete(scopeKey);
		this.lastReviewed.delete(scopeKey);
	}

	dispose(): void {
		this.disposable.dispose();
		this.chunks.clear();
		this.snapshots.clear();
		this.lastReviewed.clear();
	}
}

function changedRegion(previous: string, current: string): ChangedRegion | undefined {
	let prefix = 0;
	while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < previous.length - prefix
		&& suffix < current.length - prefix
		&& previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]
	) {
		suffix++;
	}
	if (prefix === previous.length && prefix === current.length) {
		return undefined;
	}

	const startOffset = previous.lastIndexOf('\n', prefix - 1) + 1;
	const oldChangedEnd = previous.length - suffix;
	const newChangedEnd = current.length - suffix;
	const oldNewline = previous.indexOf('\n', oldChangedEnd);
	const newNewline = current.indexOf('\n', newChangedEnd);
	const oldEnd = oldNewline < 0 ? previous.length : oldNewline + 1;
	const newEnd = newNewline < 0 ? current.length : newNewline + 1;
	return {
		startOffset,
		originalText: previous.slice(startOffset, oldEnd),
		currentText: current.slice(startOffset, newEnd),
	};
}

function mergeRegion(chunk: ChangeChunk, incoming: ChangedRegion): ChangedRegion | undefined {
	const topBeg = chunk.startOffset;
	const topEnd = topBeg + chunk.currentText.length;
	const incomingEnd = incoming.startOffset + incoming.originalText.length;
	if (incoming.startOffset >= topBeg && incomingEnd <= topEnd) {
		const offset = incoming.startOffset - topBeg;
		return {
			startOffset: topBeg,
			originalText: chunk.originalText,
			currentText: chunk.currentText.slice(0, offset)
				+ incoming.currentText
				+ chunk.currentText.slice(offset + incoming.originalText.length),
		};
	}
	if (incoming.startOffset === topEnd) {
		return {
			startOffset: topBeg,
			originalText: chunk.originalText + incoming.originalText,
			currentText: chunk.currentText + incoming.currentText,
		};
	}
	if (incomingEnd === topBeg) {
		return {
			startOffset: incoming.startOffset,
			originalText: incoming.originalText + chunk.originalText,
			currentText: incoming.currentText + chunk.currentText,
		};
	}
	return undefined;
}
