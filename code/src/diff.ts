import { ChangeChunk } from './types';

export interface NumberedDiff {
	text: string;
	addedLines: Array<{ line: number; text: string }>;
}

interface DiffOperation {
	kind: 'context' | 'remove' | 'add';
	text: string;
	oldLine: number;
	newLine: number;
}

export function reconstructOriginal(currentText: string, changes: ChangeChunk[]): string {
	let original = currentText;
	for (const change of [...changes].reverse()) {
		const start = Math.max(0, Math.min(change.startOffset, original.length));
		const end = Math.min(original.length, start + change.currentText.length);
		original = original.slice(0, start) + change.originalText + original.slice(end);
	}
	return original;
}

export function createNumberedDiff(originalText: string, currentText: string): NumberedDiff {
	const original = splitLines(originalText);
	const current = splitLines(currentText);
	if (original.length === 0 && current.length === 0) {
		return { text: '', addedLines: [] };
	}
	if ((original.length + 1) * (current.length + 1) > 1_000_000) {
		return createSingleHunk(original, current);
	}

	const operations = createOperations(original, current);
	const changed = operations.flatMap((operation, index) => operation.kind === 'context' ? [] : [index]);
	if (changed.length === 0) {
		return { text: '', addedLines: [] };
	}

	const hunks: Array<{ start: number; end: number }> = [];
	for (const index of changed) {
		const start = Math.max(0, index - 3);
		const end = Math.min(operations.length, index + 4);
		const last = hunks[hunks.length - 1];
		if (last && start <= last.end) {
			last.end = Math.max(last.end, end);
		} else {
			hunks.push({ start, end });
		}
	}

	const addedLines: NumberedDiff['addedLines'] = [];
	const output: string[] = [];
	for (const hunk of hunks) {
		const hunkOperations = operations.slice(hunk.start, hunk.end);
		const oldCount = hunkOperations.filter((operation) => operation.kind !== 'add').length;
		const newCount = hunkOperations.filter((operation) => operation.kind !== 'remove').length;
		const firstOldLine = hunkOperations.find((operation) => operation.kind !== 'add')?.oldLine;
		const firstNewLine = hunkOperations.find((operation) => operation.kind !== 'remove')?.newLine;
		const oldStart = firstOldLine ?? hunkOperations[0].oldLine - 1;
		const newStart = firstNewLine ?? hunkOperations[0].newLine - 1;
		output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		for (const operation of hunkOperations) {
			if (operation.kind === 'context') {
				output.push(`${operation.newLine.toString().padStart(6, ' ')} ${operation.text}`);
			} else if (operation.kind === 'remove') {
				output.push(`old -${operation.text}`);
			} else {
				output.push(`${operation.newLine.toString().padStart(6, ' ')} +${operation.text}`);
				addedLines.push({ line: operation.newLine, text: operation.text });
			}
		}
	}
	return { text: output.join('\n'), addedLines };
}

function createOperations(original: string[], current: string[]): DiffOperation[] {
	const width = current.length + 1;
	const table = new Uint32Array((original.length + 1) * width);
	for (let oldIndex = original.length - 1; oldIndex >= 0; oldIndex--) {
		for (let newIndex = current.length - 1; newIndex >= 0; newIndex--) {
			const index = oldIndex * width + newIndex;
			table[index] = original[oldIndex] === current[newIndex]
				? 1 + table[(oldIndex + 1) * width + newIndex + 1]
				: Math.max(table[(oldIndex + 1) * width + newIndex], table[index + 1]);
		}
	}

	const operations: DiffOperation[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < original.length || newIndex < current.length) {
		if (oldIndex < original.length && newIndex < current.length && original[oldIndex] === current[newIndex]) {
			operations.push({
				kind: 'context',
				text: current[newIndex],
				oldLine: oldIndex + 1,
				newLine: newIndex + 1,
			});
			oldIndex++;
			newIndex++;
		} else if (
			oldIndex < original.length
			&& (newIndex >= current.length
				|| table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1])
		) {
			operations.push({
				kind: 'remove',
				text: original[oldIndex],
				oldLine: oldIndex + 1,
				newLine: newIndex + 1,
			});
			oldIndex++;
		} else {
			operations.push({
				kind: 'add',
				text: current[newIndex],
				oldLine: oldIndex + 1,
				newLine: newIndex + 1,
			});
			newIndex++;
		}
	}
	return operations;
}

function createSingleHunk(original: string[], current: string[]): NumberedDiff {
	let prefix = 0;
	while (prefix < original.length && prefix < current.length && original[prefix] === current[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < original.length - prefix
		&& suffix < current.length - prefix
		&& original[original.length - 1 - suffix] === current[current.length - 1 - suffix]
	) {
		suffix++;
	}
	const start = Math.max(0, prefix - 3);
	const oldChangedEnd = original.length - suffix;
	const newChangedEnd = current.length - suffix;
	const contextAfter = Math.min(3, suffix);
	const oldCount = prefix - start + oldChangedEnd - prefix + contextAfter;
	const newCount = prefix - start + newChangedEnd - prefix + contextAfter;
	const oldStart = oldCount > 0 ? start + 1 : start;
	const newStart = newCount > 0 ? start + 1 : start;
	const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
	const addedLines: NumberedDiff['addedLines'] = [];
	for (let index = start; index < prefix; index++) {
		lines.push(`${(index + 1).toString().padStart(6, ' ')} ${current[index]}`);
	}
	for (let index = prefix; index < oldChangedEnd; index++) {
		lines.push(`old -${original[index]}`);
	}
	for (let index = prefix; index < newChangedEnd; index++) {
		lines.push(`${(index + 1).toString().padStart(6, ' ')} +${current[index]}`);
		addedLines.push({ line: index + 1, text: current[index] });
	}
	for (let index = newChangedEnd; index < newChangedEnd + contextAfter; index++) {
		lines.push(`${(index + 1).toString().padStart(6, ' ')} ${current[index]}`);
	}
	return { text: lines.join('\n'), addedLines };
}

function splitLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const lines = text.split(/\r?\n/);
	if (/\r?\n$/.test(text)) {
		lines.pop();
	}
	return lines;
}
