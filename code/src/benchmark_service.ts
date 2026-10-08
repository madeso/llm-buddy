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

export interface BenchmarkStatus {
	lastResults: BenchmarkResult[];
	running: boolean;
}

export const benchmark_run = async (self: BenchmarkStatus, selfOutput: vscode.OutputChannel, selfTracker: ChangeTracker, selfNotes: NotesManager, selfReviews: ReviewService): Promise<void> => {
	if (self.running) {
		throw new Error('A benchmark run is already in progress.');
	}
	self.running = true;
	const results: BenchmarkResult[] = [];
	selfOutput.clear();
	selfOutput.appendLine(`Running ${benchmarkCases.length} llm-buddy benchmarks...`);
	selfOutput.show(true);
	try {
		for (const benchmarkCase of benchmarkCases) {
			const startedAt = Date.now();
			const document = await vscode.workspace.openTextDocument({
				language: benchmarkCase.language,
				content: '',
			});
			const uri = document.uri;
			const scopeKey = getScopeKey(uri);
			selfTracker.seedDocument(document);
			try {
				const edit = new vscode.WorkspaceEdit();
				edit.insert(uri, new vscode.Position(0, 0), benchmarkCase.content);
				if (!await vscode.workspace.applyEdit(edit)) {
					throw new Error(`Could not prepare benchmark document: ${benchmarkCase.name}`);
				}
				await selfReviews.review(uri, false);
				const found = selfNotes.list(scopeKey).filter((note) => note.status === 'active');
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
				selfOutput.appendLine(
					`${benchmarkCase.name}: TP=${truePositives} FP=${falsePositives} FN=${falseNegatives}`,
				);
			} finally {
				selfNotes.removeScope(scopeKey);
				selfTracker.removeScope(scopeKey);
			}
		}
		self.lastResults = results;
		const markdown_report = generate_report_md(results);
		selfOutput.appendLine(markdown_report);
		vscode.window.showInformationMessage('llm-buddy benchmark run complete.');
	} finally {
		self.running = false;
	}
};

type FileFilters = { [name: string]: string[] };
const FILTERS_MD : FileFilters = { Markdown: ['md'] };
const FILTERS_HTML = { HTML: ['html'] };

interface SaveArgs {
	default_file_name: string;
	filters: FileFilters;
	content: string;
	ok_message: string;
}
export const save_file = async (args: SaveArgs): Promise<void> => {
	const {default_file_name, filters, content, ok_message} = args;
	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0].uri ?? vscode.Uri.file(''), default_file_name),
		filters,
	});
	if (!target) {
		return;
	}
	await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
	vscode.window.showInformationMessage(ok_message);
};

const PLEASE_RUN_BENCHMARKS = 'Run llm-buddy benchmarks before exporting a report.';

const has_results = (results: BenchmarkResult[]): boolean => results.length !== 0;

type BenchmarkExportArgs = Omit<SaveArgs, 'content'>;
const BENCHMARK_EXPORT_MD : BenchmarkExportArgs = {
	default_file_name: 'llm-buddy-benchmark.md',
	filters: FILTERS_MD,
	ok_message: 'llm-buddy benchmark report exported.'
};
const BENCHMARK_EXPORT_HTML : BenchmarkExportArgs = {
	default_file_name: 'llm-buddy-benchmark.html',
	filters: FILTERS_HTML,
	ok_message: 'llm-buddy HTML benchmark report exported.'
};

export const benchmark_exportReport = async (results: BenchmarkResult[]): Promise<void> => {
	if (has_results(results)) {
		await save_file({...BENCHMARK_EXPORT_MD, content: generate_report_md(results)});
	}
	else {
		vscode.window.showInformationMessage(PLEASE_RUN_BENCHMARKS);
	}
};

export const benchmark_exportHtmlReport = async (results: BenchmarkResult[]): Promise<void> => {
	if (has_results(results)) {
		await save_file({...BENCHMARK_EXPORT_HTML, content: generate_report_html(results)});
	}
	else {
		vscode.window.showInformationMessage(PLEASE_RUN_BENCHMARKS);
	}
};

const generate_report_md = (results: BenchmarkResult[]): string => {
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
};

const escapeMarkdown = (text: string): string => {
	return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
};

const generate_report_html = (results: BenchmarkResult[]): string => {
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
};

const escapeHtml = (text: string): string => {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
};
