import * as assert from 'assert';
import { createNumberedDiff, reconstructOriginal } from '../diff';

suite('Numbered diff', () => {
	test('returns no output for identical text', () => {
		assert.deepStrictEqual(createNumberedDiff('one\ntwo\n', 'one\ntwo\n'), {
			text: '',
			addedLines: [],
		});
	});

	test('numbers current added lines and marks removed lines as old', () => {
		const diff = createNumberedDiff('first\nold value\nlast\n', 'first\nnew value\nlast\n');
		assert.match(diff.text, /old -old value/);
		assert.match(diff.text, /2 \+new value/);
		assert.deepStrictEqual(diff.addedLines, [{ line: 2, text: 'new value' }]);
	});

	test('tracks insertion line positions', () => {
		const diff = createNumberedDiff('first\nlast\n', 'first\ninserted\nlast\n');
		assert.deepStrictEqual(diff.addedLines, [{ line: 2, text: 'inserted' }]);
		assert.match(diff.text, /@@ -1,2 \+1,3 @@/);
	});

	test('keeps distant edits in separate hunks', () => {
		const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
		const currentLines = original.split('\n');
		currentLines[1] = 'changed second';
		currentLines[17] = 'changed eighteenth';
		const diff = createNumberedDiff(original, currentLines.join('\n'));
		assert.strictEqual((diff.text.match(/^@@/gm) ?? []).length, 2);
		assert.deepStrictEqual(diff.addedLines.map(({ line }) => line), [2, 18]);
	});

	test('reconstructs the baseline by reversing edits', () => {
		const original = reconstructOriginal('first changed\nsecond\n', [{
			uri: 'file:///example.txt',
			scopeKey: 'document:file:///example.txt',
			fileName: 'example.txt',
			languageId: 'plaintext',
			startOffset: 6,
			originalText: 'value',
			currentText: 'changed',
			revision: 1,
			startedAt: 1,
			lastChangedAt: 2,
		}]);
		assert.strictEqual(original, 'first value\nsecond\n');
	});
});
