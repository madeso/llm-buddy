import * as vscode from 'vscode';
import { benchmarkCases } from './benchmark_cases';
import { ChangeTracker, getScopeKey } from './change_tracker';
import { NotesManager } from './notes_manager';
import { ReviewService } from './review_service';

interface BenchmarkResult {
	name: string;
	truePositives: number;
	falsePositives: number;
	falseNegatives: number;
	elapsedSeconds: number;
	found: string[];
}

export class BenchmarkService {
	private lastReport = '';
	private lastResults: BenchmarkResult[] = [];
	private running = false;
	private readonly output = vscode.window.createOutputChannel('llm-buddy benchmarks');

	constructor(
		private readonly tracker: ChangeTracker,
		private readonly notes: NotesManager,
		private readonly reviews: ReviewService,
	) {}

	async run(): Promise<void> {
		if (this.running) {
			throw new Error('A benchmark run is already in progress.');
		}
		this.running = true;
		const results: BenchmarkResult[] = [];
		this.output.clear();
		this.output.appendLine(`Running ${benchmarkCases.length} llm-buddy benchmarks...`);
		this.output.show(true);
		try {
			for (const benchmarkCase of benchmarkCases) {
				const startedAt = Date.now();
				const document = await vscode.workspace.openTextDocument({
					language: benchmarkCase.language,
					content: '',
				});
				const uri = document.uri;
				const scopeKey = getScopeKey(uri);
				this.tracker.seedDocument(document);
				try {
					const edit = new vscode.WorkspaceEdit();
					edit.insert(uri, new vscode.Position(0, 0), benchmarkCase.content);
					if (!await vscode.workspace.applyEdit(edit)) {
						throw new Error(`Could not prepare benchmark document: ${benchmarkCase.name}`);
					}
					await this.reviews.review(uri, false);
					const found = this.notes.list(scopeKey).filter((note) => note.status === 'active');
					const matched = new Set<number>();
					let truePositives = 0;
					let falseNegatives = 0;
					for (const expected of benchmarkCase.expected) {
						const match = found.findIndex((note, index) =>
							!matched.has(index)
							&& note.line === expected.line
							&& expected.pattern.test(note.message),
						);
						if (match >= 0) {
							matched.add(match);
							truePositives++;
						} else {
							falseNegatives++;
						}
					}
					const falsePositives = found.length - truePositives;
					results.push({
						name: benchmarkCase.name,
						truePositives,
						falsePositives,
						falseNegatives,
						elapsedSeconds: (Date.now() - startedAt) / 1000,
						found: found.map((note) => `${note.line}: ${note.message}`),
					});
					this.output.appendLine(
						`${benchmarkCase.name}: TP=${truePositives} FP=${falsePositives} FN=${falseNegatives}`,
					);
				} finally {
					this.notes.removeScope(scopeKey);
					this.tracker.removeScope(scopeKey);
				}
			}
			this.lastResults = results;
			this.lastReport = formatMarkdownReport(results);
			this.output.appendLine(this.lastReport);
			void vscode.window.showInformationMessage('llm-buddy benchmark run complete.');
		} finally {
			this.running = false;
		}
	}

	async exportReport(): Promise<void> {
		if (!this.lastReport) {
			void vscode.window.showInformationMessage('Run llm-buddy benchmarks before exporting a report.');
			return;
		}
		const target = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0].uri ?? vscode.Uri.file(''), 'llm-buddy-benchmark.md'),
			filters: { Markdown: ['md'] },
		});
		if (!target) {
			return;
		}
		await vscode.workspace.fs.writeFile(target, Buffer.from(this.lastReport, 'utf8'));
		void vscode.window.showInformationMessage('llm-buddy benchmark report exported.');
	}

	async exportHtmlReport(): Promise<void> {
		if (this.lastResults.length === 0) {
			void vscode.window.showInformationMessage('Run llm-buddy benchmarks before exporting a report.');
			return;
		}
		const target = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0].uri ?? vscode.Uri.file(''), 'llm-buddy-benchmark.html'),
			filters: { HTML: ['html'] },
		});
		if (!target) {
			return;
		}
		await vscode.workspace.fs.writeFile(target, Buffer.from(formatHtmlReport(this.lastResults), 'utf8'));
		void vscode.window.showInformationMessage('llm-buddy HTML benchmark report exported.');
	}

	dispose(): void {
		this.output.dispose();
	}
}

function formatMarkdownReport(results: BenchmarkResult[]): string {
	const truePositives = results.reduce((total, result) => total + result.truePositives, 0);
	const falsePositives = results.reduce((total, result) => total + result.falsePositives, 0);
	const falseNegatives = results.reduce((total, result) => total + result.falseNegatives, 0);
	const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
	const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;
	const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
	const lines = [
		'# llm-buddy benchmark report',
		'',
		'| Case | TP | FP | FN | Time (s) |',
		'| --- | ---: | ---: | ---: | ---: |',
		...results.map((result) =>
			`| ${escapeMarkdown(result.name)} | ${result.truePositives} | ${result.falsePositives} | ${result.falseNegatives} | ${result.elapsedSeconds.toFixed(1)} |`,
		),
		'',
		`**Total:** TP=${truePositives}, FP=${falsePositives}, FN=${falseNegatives}`,
		`**Precision:** ${precision.toFixed(3)}  **Recall:** ${recall.toFixed(3)}  **F1:** ${f1.toFixed(3)}`,
		'',
		...results.flatMap((result) => [
			`## ${result.name}`,
			'',
			...(result.found.length ? result.found.map((message) => `- ${escapeMarkdown(message)}`) : ['No notes found.']),
			'',
		]),
	];
	return lines.join('\n');
}

function escapeMarkdown(text: string): string {
	return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function formatHtmlReport(results: BenchmarkResult[]): string {
	const truePositives = results.reduce((total, result) => total + result.truePositives, 0);
	const falsePositives = results.reduce((total, result) => total + result.falsePositives, 0);
	const falseNegatives = results.reduce((total, result) => total + result.falseNegatives, 0);
	const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
	const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;
	const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
	const rows = results.map((result) => `<tr><td>${escapeHtml(result.name)}</td><td>${result.truePositives}</td><td>${result.falsePositives}</td><td>${result.falseNegatives}</td><td>${result.elapsedSeconds.toFixed(1)}</td><td>${result.found.map(escapeHtml).join('<br>') || 'No notes found.'}</td></tr>`).join('\n');
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>llm-buddy benchmark report</title>
<style>body{font:14px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.5rem;text-align:left}th{background:#f2f2f2}.summary{font-weight:600}</style>
<h1>llm-buddy benchmark report</h1>
<p class="summary">Precision: ${precision.toFixed(3)} · Recall: ${recall.toFixed(3)} · F1: ${f1.toFixed(3)}</p>
<table><thead><tr><th>Case</th><th>TP</th><th>FP</th><th>FN</th><th>Seconds</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>
</html>`;
}

function escapeHtml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
