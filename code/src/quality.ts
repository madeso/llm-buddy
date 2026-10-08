import * as vscode from 'vscode';
import { ReviewCapture } from './review_service';
import { get_setting_or } from './settings';

const LAST_CAPTURE_KEY = 'llmBuddy.quality.lastCapture';
type Capture =
	({type: "review"}  & ReviewCapture) |
	({type: "quality"} & QualityCapture);

const update_last_capture = async (context: vscode.ExtensionContext, what: Capture) => {
	await context.workspaceState.update(LAST_CAPTURE_KEY, what);
};
const get_last_capture = (context: vscode.ExtensionContext) => {
	return context.workspaceState.get<Capture | undefined>(LAST_CAPTURE_KEY, undefined);
};

const CASES_KEY = 'llmBuddy.quality.cases';
const update_cases = async (context: vscode.ExtensionContext, what: JudgedQualityCase[]) => {
	await context.workspaceState.update(CASES_KEY, what);
};
const get_cases = (context: vscode.ExtensionContext) => {
	return context.workspaceState.get<JudgedQualityCase[]>(CASES_KEY, []);
};


interface ExpectedWarning {
	uri: string;
	line: number;
	message: string;
}

interface QualityJudgment {
	kind: 'clean' | 'warnings';
	warnings: ExpectedWarning[];
}

interface Note {
	line: number;
	message: string;
	severity: string;
};

interface QualityDiffItem {
	id: number;
	uri?: string;
	file: string;
	language: string;
	diff: string;
	actualNotes: Array<Note>;
	judgment?: QualityJudgment;
}

interface JudgedQualityCase {
	judgedAt: number;
	capture: ReviewCapture;
	items: QualityDiffItem[];
}

interface QualityCapture {
	capture: ReviewCapture;
	items?: QualityDiffItem[];
}

export function createQualityItems(capture: ReviewCapture): QualityDiffItem[] {
	const segments = splitDiffByFile(capture.diff);
	return segments.map((segment, id) => {
		const header = segment.split(/\r?\n/, 1)[0] ?? '';
		const match = /^=== File: (.*?)  Language: ([^\s]+)(?:  |$)/.exec(header);
		const file = match?.[1] ?? 'unknown';
		const language = match?.[2] ?? 'unknown';
		const uri = capture.files?.find((item) => item.file === file || safeFsPath(item.uri) === file)?.uri
			?? capture.notes.find((note) => note.uri && (note.uri === file || safeFsPath(note.uri) === file))?.uri;
		return {
			id,
			...(uri ? { uri } : {}),
			file,
			language,
			diff: segment,
			actualNotes: capture.notes
				.filter((note) => note.uri === uri || (!uri && safeFsPath(note.uri) === file))
				.map(({ line, message, severity }) => ({ line, message, severity })),
		};
	});
}

export function splitDiffByFile(diff: string): string[] {
	const starts: number[] = [];
	const headerPattern = /^=== File:/gm;
	for (let match = headerPattern.exec(diff); match; match = headerPattern.exec(diff)) {
		starts.push(match.index);
	}
	if (starts.length === 0) {
		const trimmed = diff.trim();
		return trimmed ? [trimmed] : [];
	}
	return starts.map((start, index) => diff.slice(start, starts[index + 1] ?? diff.length).trimEnd());
}

export function setCleanJudgment(item: QualityDiffItem): void {
	item.judgment = { kind: 'clean', warnings: [] };
}

export function addExpectedWarning(item: QualityDiffItem, warning: ExpectedWarning): void {
	const warnings = item.judgment?.kind === 'warnings' ? [...item.judgment.warnings] : [];
	warnings.push(warning);
	item.judgment = { kind: 'warnings', warnings };
}

export function clearJudgment(item: QualityDiffItem): void {
	delete item.judgment;
}

const judgmentActions = (
	item: QualityDiffItem,
	index: number,
	items: QualityDiffItem[],
): Array<vscode.QuickPickItem & { action: 'clean' | 'warning' | 'clear' | 'previous' | 'next' | 'save' | 'diff' | 'info' }>  => {
	const actualSummary = item.actualNotes.length > 0
		? item.actualNotes.map((note) => `Actual: ${note.line}: ${note.message}`).join(' · ')
		: 'No warnings were produced by this review.';
	const actions: Array<vscode.QuickPickItem & { action: 'clean' | 'warning' | 'clear' | 'previous' | 'next' | 'save' | 'diff' | 'info' }> = [
		{ label: 'Open captured diff', description: 'View the review input for this file.', action: 'diff' },
		{ label: 'Mark clean', description: 'No warning should be shown for this diff.', action: 'clean' },
		{ label: 'Add expected warning', description: 'Record a warning with line number and text.', action: 'warning' },
		{ label: 'Clear judgment', description: 'Return this diff to the not-judged state.', action: 'clear' },
	];
	if (index > 0) {
		actions.push({ label: 'Previous diff', action: 'previous' });
	}
	if (index < items.length - 1) {
		actions.push({ label: 'Next diff', action: 'next' });
	}
	if (items.every((candidate) => candidate.judgment)) {
		actions.push({ label: 'Save judged case', description: 'All diff sections have judgments.', action: 'save' });
	}
	const warningSummary = item.judgment?.warnings
		.map((warning) => `Expected: ${warning.line}: ${warning.message}`)
		.join(' · ');
	actions.unshift({
		label: actualSummary,
		description: warningSummary || `Current judgment: ${item.judgment?.kind ?? 'not judged'}`,
		kind: vscode.QuickPickItemKind.Separator,
		action: 'info',
	});
	return actions;
};

const promptExpectedWarning = async (item: QualityDiffItem): Promise<boolean> => {
	const lineInput = await vscode.window.showInputBox({
		prompt: `Expected warning line in ${item.file}`,
		placeHolder: '1',
		validateInput: (value) => /^\d+$/.test(value) && Number(value) > 0 ? undefined : 'Enter a positive line number.',
		ignoreFocusOut: true,
	});
	if (lineInput === undefined) {
		return false;
	}
	const message = await vscode.window.showInputBox({
		prompt: 'Describe the expected warning',
		ignoreFocusOut: true,
	});
	if (message === undefined) {
		return false;
	}
	addExpectedWarning(item, {
		uri: item.uri ?? item.file,
		line: Number(lineInput),
		message,
	});
	return true;
};

const saveJudgment = async (context: vscode.ExtensionContext, capture: ReviewCapture, items: QualityDiffItem[]): Promise<void> => {
	const judgedCase: JudgedQualityCase = {
		judgedAt: Date.now(),
		capture: { ...capture },
		items: items.map((item) => ({
			...item,
			actualNotes: item.actualNotes.map((note) => ({ ...note })),
			judgment: item.judgment
				? { ...item.judgment, warnings: item.judgment.warnings.map((warning) => ({ ...warning })) }
				: undefined,
		})),
	};
	const cases = get_cases(context);
	cases.push(judgedCase);
	await update_cases(context, cases);
	await update_last_capture(context, {
		type: "quality",
		capture: judgedCase.capture,
		items: judgedCase.items,
	});
	vscode.window.showInformationMessage('llm-buddy quality judgment saved.');
};


export const quality_handleCapture = (selfContext: vscode.ExtensionContext, capture: ReviewCapture): void => {
	if (!get_setting_or('captureQualityData', false)) {
		return;
	}
	Promise.resolve(update_last_capture(selfContext, {...capture, type: 'review'}))
		.catch((error: unknown) => console.error('llm-buddy could not save review capture:', error));
};

export const quality_judgeLastCapture = async (selfContext: vscode.ExtensionContext): Promise<void> => {
	const saved = get_last_capture(selfContext);
	if (!saved) {
		vscode.window.showInformationMessage('No saved review capture; enable quality capture and run a review first.');
		return;
	}
	const capture = saved.type === 'quality' ? saved.capture : saved;
	const saved_items = saved.type === 'quality' ? saved.items ?? [] : [];
	const generated_items = saved_items.length !== 0 ? saved_items : createQualityItems(capture);

	// perform a copy... is this needed?
	const items = generated_items.map((item) => ({ ...item, actualNotes: item.actualNotes.map((note) => ({ ...note })) }));
	if (items.length === 0) {
		vscode.window.showInformationMessage('The saved review has no diff sections to judge.');
		return;
	}
	let index = 0;
	while (true) {
		const current_item = items[index];
		const choice = await vscode.window.showQuickPick(judgmentActions(current_item, index, items), {
			placeHolder: `Judge diff ${index + 1}/${items.length}: ${current_item.file} (${current_item.language})`,
			title: `llm-buddy quality judge · ${current_item.judgment?.kind ?? 'not judged'}`,
			ignoreFocusOut: true,
		});
		if (!choice) {
			return;
		}
		switch (choice.action) {
			case 'clean':
				setCleanJudgment(current_item);
				break;
			case 'warning':
				if (!await promptExpectedWarning(current_item)) {
					break;
				}
				break;
			case 'clear':
				clearJudgment(current_item);
				break;
			case 'previous':
				index = Math.max(0, index - 1);
				break;
			case 'next':
				index = Math.min(items.length - 1, index + 1);
				break;
			case 'save':
				await saveJudgment(selfContext, capture, items);
				return;
			case 'diff': {
				const diffDocument = await vscode.workspace.openTextDocument({
					language: current_item.language,
					content: current_item.diff,
				});
				await vscode.window.showTextDocument(diffDocument, { preview: true });
				break;
			}
			case 'info':
				break;
		}
	}
};

export const quality_exportCases = async (selfContext: vscode.ExtensionContext): Promise<void> => {
	const cases = get_cases(selfContext);
	if (cases.length === 0) {
		vscode.window.showInformationMessage('There are no judged quality cases to export.');
		return;
	}
	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0].uri ?? selfContext.globalStorageUri, 'llm-buddy-quality.json'),
		filters: { JSON: ['json'] },
	});
	if (!target) {
		return;
	}
	await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(cases, null, 2), 'utf8'));
	vscode.window.showInformationMessage(`Exported ${cases.length} quality case(s).`);
};

function safeFsPath(uri: string): string {
	try {
		return vscode.Uri.parse(uri).fsPath;
	} catch {
		return uri;
	}
}
