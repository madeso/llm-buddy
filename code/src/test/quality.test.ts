import * as assert from 'assert';
import {
	addExpectedWarning,
	clearJudgment,
	createQualityItems,
	setCleanJudgment,
	splitDiffByFile,
} from '../quality';
import { ReviewCapture } from '../review_service';

suite('Quality judging', () => {
	const capture: ReviewCapture = {
		scopeKey: 'workspace:file:///workspace',
		provider: 'openai-compatible',
		startedAt: 1,
		finishedAt: 2,
		diff: [
			'=== File: C:\\workspace\\first.ts  Language: typescript  Project: app  Cursor: line 1 ===',
			'@@ -1,1 +1,1 @@',
			'     1 -old',
			'     1 +new',
			'',
			'=== File: C:\\workspace\\second.ts  Language: typescript  Project: app  Cursor: line unknown ===',
			'@@ -1,1 +1,1 @@',
			'     1 -before',
			'     1 +after',
		].join('\n'),
		responses: [],
		toolEvents: [],
		files: [
			{ uri: 'file:///workspace/first.ts', file: 'C:\\workspace\\first.ts', language: 'typescript' },
			{ uri: 'file:///workspace/second.ts', file: 'C:\\workspace\\second.ts', language: 'typescript' },
		],
		notes: [
			{
				id: 1,
				uri: 'file:///workspace/second.ts',
				line: 1,
				message: 'Actual second-file finding.',
				severity: 'significant',
			},
		],
	};

	test('splits captured diff into per-file judging items and associates findings', () => {
		const items = createQualityItems(capture);
		assert.strictEqual(splitDiffByFile(capture.diff).length, 2);
		assert.deepStrictEqual(items.map((item) => item.file), [
			'C:\\workspace\\first.ts',
			'C:\\workspace\\second.ts',
		]);
		assert.strictEqual(items[0].actualNotes.length, 0);
		assert.strictEqual(items[1].actualNotes[0].message, 'Actual second-file finding.');
	});

	test('records clean, multiple line-specific warnings, and cleared judgments', () => {
		const [item] = createQualityItems(capture);
		setCleanJudgment(item);
		assert.deepStrictEqual(item.judgment, { kind: 'clean', warnings: [] });
		addExpectedWarning(item, {
			uri: item.uri ?? item.file,
			line: 1,
			message: 'Expected first warning.',
		});
		addExpectedWarning(item, {
			uri: item.uri ?? item.file,
			line: 2,
			message: 'Expected second warning.',
		});
		assert.deepStrictEqual(item.judgment?.warnings.map((warning) => warning.line), [1, 2]);
		clearJudgment(item);
		assert.strictEqual(item.judgment, undefined);
	});
});
