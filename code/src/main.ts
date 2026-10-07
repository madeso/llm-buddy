import * as vscode from 'vscode';
import { BenchmarkService } from './benchmark_service';
import { ChangeTracker, getScopeKey } from './change_tracker';
import { NotesManager } from './notes_manager';
import { apiKeySecretKey, createProvider } from './providers';
import { QualityService } from './quality';
import { ReviewService } from './review_service';
import { get_setting_or } from './settings';

export function activate(context: vscode.ExtensionContext): void {
	const tracker = new ChangeTracker(get_setting_or('coalesceWindow', 180));
	const notes = new NotesManager(context);

	const reviews = new ReviewService(tracker, notes, () => createProvider(context));
	const quality = new QualityService(context);
	const benchmarks = new BenchmarkService(tracker, notes, reviews);

	const scopeKey_to_automaticTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const scopeKey_to_lastAutomaticRuns = new Map<string, number>();

	context.subscriptions.push(tracker, notes, reviews, benchmarks);
	reviews.setCaptureHandler((capture) => quality.handleCapture(capture));

	const find_openDocument_from_ScopeKey = (scopeKey: string): vscode.TextDocument | undefined =>
		vscode.workspace.textDocuments.find((document) => getScopeKey(document.uri) === scopeKey);

	const scheduleReview = (scopeKey: string, delay_in_seconds: number): void => {
		const old_timer = scopeKey_to_automaticTimers.get(scopeKey);
		if (old_timer) {
			clearTimeout(old_timer);
		}
		const timer = setTimeout(() => {
			scopeKey_to_automaticTimers.delete(scopeKey);
			if (!get_setting_or('enabled', false)) {
				return;
			}
			const interval = Math.max(0, get_setting_or('autoInterval', 60)) * 1000;
			const last_run = scopeKey_to_lastAutomaticRuns.get(scopeKey);
			const remaining = interval - (Date.now() - (last_run ?? 0));
			if (remaining > 0) {
				scheduleReview(scopeKey, Math.max(delay_in_seconds, remaining / 1000));
				return;
			}
			const document = find_openDocument_from_ScopeKey(scopeKey);
			if (document) {
				scopeKey_to_lastAutomaticRuns.set(scopeKey, Date.now());
				void reviews.review(document.uri);
			}
		}, Math.max(0, delay_in_seconds) * 1000);
		scopeKey_to_automaticTimers.set(scopeKey, timer);
	};

	notes.setEditedHandler((scopeKey) => {
		scheduleReview(scopeKey, get_setting_or('autoIdleDelay', 10));
	});

	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
		if (event.contentChanges.length > 0 && get_setting_or('enabled', false)) {
			scheduleReview(getScopeKey(event.document.uri), get_setting_or('autoIdleDelay', 10));
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
		const enabled = !get_setting_or('enabled', false);
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
		const enabled = !get_setting_or('captureQualityData', false);
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
			for (const timer of scopeKey_to_automaticTimers.values()) {
				clearTimeout(timer);
			}
			scopeKey_to_automaticTimers.clear();
		},
	});
}

export function deactivate(): void {}
