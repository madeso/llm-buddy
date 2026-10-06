import * as vscode from 'vscode';
import { BenchmarkService } from './benchmarkService';
import { ChangeTracker, getScopeKey } from './changeTracker';
import { NotesManager } from './notes';
import { apiKeySecretKey, createProvider } from './providers';
import { QualityService } from './quality';
import { ReviewService } from './reviewService';
import { getSetting } from './settings';

export function activate(context: vscode.ExtensionContext): void {
	const tracker = new ChangeTracker(getSetting('coalesceWindow', 180));
	const notes = new NotesManager(context);
	const reviews = new ReviewService(tracker, notes, () => createProvider(context));
	const quality = new QualityService(context);
	const benchmarks = new BenchmarkService(tracker, notes, reviews);
	const automaticTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const lastAutomaticRuns = new Map<string, number>();

	context.subscriptions.push(tracker, notes, reviews, benchmarks);
	reviews.setCaptureHandler((capture) => quality.handleCapture(capture));

	const openDocumentForScope = (scopeKey: string): vscode.TextDocument | undefined =>
		vscode.workspace.textDocuments.find((document) => getScopeKey(document.uri) === scopeKey);

	const scheduleReview = (scopeKey: string, delaySeconds: number): void => {
		const previous = automaticTimers.get(scopeKey);
		if (previous) {
			clearTimeout(previous);
		}
		const timer = setTimeout(() => {
			automaticTimers.delete(scopeKey);
			if (!getSetting('enabled', false)) {
				return;
			}
			const interval = Math.max(0, getSetting('autoInterval', 60)) * 1000;
			const remaining = interval - (Date.now() - (lastAutomaticRuns.get(scopeKey) ?? 0));
			if (remaining > 0) {
				scheduleReview(scopeKey, Math.max(delaySeconds, remaining / 1000));
				return;
			}
			const document = openDocumentForScope(scopeKey);
			if (document) {
				lastAutomaticRuns.set(scopeKey, Date.now());
				void reviews.review(document.uri);
			}
		}, Math.max(0, delaySeconds) * 1000);
		automaticTimers.set(scopeKey, timer);
	};

	notes.setEditedHandler((scopeKey) => {
		scheduleReview(scopeKey, getSetting('autoIdleDelay', 10));
	});

	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
		if (event.contentChanges.length > 0 && getSetting('enabled', false)) {
			scheduleReview(getScopeKey(event.document.uri), getSetting('autoIdleDelay', 10));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.reviewChanges', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showInformationMessage('llm-buddy: open a document to review its changes.');
			return;
		}
		await reviews.review(editor.document.uri);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.clearHistory', () => {
		tracker.clearHistory();
		void vscode.window.showInformationMessage('llm-buddy change history cleared.');
	}));
	context.subscriptions.push(vscode.commands.registerCommand(
		'llmBuddy.dismissNoteAt',
		(uriString?: string, line?: number) => {
			if (uriString && typeof line === 'number') {
				notes.dismissAt(uriString, line);
				return;
			}
			const editor = vscode.window.activeTextEditor;
			if (!editor || !notes.dismissAt(editor.document.uri.toString(), editor.selection.active.line)) {
				void vscode.window.showInformationMessage('No llm-buddy note on the current line.');
			}
		},
	));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.dismissAllNotes', () => {
		notes.dismissAll();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.toggleAutomaticReview', async () => {
		const config = vscode.workspace.getConfiguration('llmBuddy');
		const enabled = !getSetting('enabled', false);
		await config.update('enabled', enabled, vscode.ConfigurationTarget.Global);
		void vscode.window.showInformationMessage(`llm-buddy automatic review ${enabled ? 'enabled' : 'disabled'}.`);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.setApiKey', async () => {
		const apiKey = await vscode.window.showInputBox({
			password: true,
			prompt: 'API key for the configured OpenAI-compatible endpoint (leave blank to clear)',
			ignoreFocusOut: true,
		});
		if (apiKey === undefined) {
			return;
		}
		if (apiKey) {
			await context.secrets.store(apiKeySecretKey, apiKey);
			void vscode.window.showInformationMessage('llm-buddy API key saved in VS Code SecretStorage.');
		} else {
			await context.secrets.delete(apiKeySecretKey);
			void vscode.window.showInformationMessage('llm-buddy API key cleared.');
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.toggleQualityCapture', async () => {
		const config = vscode.workspace.getConfiguration('llmBuddy');
		const enabled = !getSetting('captureQualityData', false);
		await config.update('captureQualityData', enabled, vscode.ConfigurationTarget.Global);
		void vscode.window.showInformationMessage(`llm-buddy quality capture ${enabled ? 'enabled' : 'disabled'}.`);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.judgeLastReview', () => quality.judgeLastCapture()));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.exportQualityCases', () => quality.exportCases()));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.runBenchmarks', async () => {
		try {
			await benchmarks.run();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`llm-buddy benchmark failed: ${message}`);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.exportBenchmarkReport', () => benchmarks.exportReport()));
	context.subscriptions.push(vscode.commands.registerCommand('llmBuddy.exportBenchmarkHtmlReport', () => benchmarks.exportHtmlReport()));

	context.subscriptions.push({
		dispose: () => {
			for (const timer of automaticTimers.values()) {
				clearTimeout(timer);
			}
			automaticTimers.clear();
		},
	});
}

export function deactivate(): void {}
