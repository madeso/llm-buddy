import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChangeTracker, getScopeKey } from '../changeTracker';
import { reconstructOriginal } from '../diff';

suite('Extension Test Suite', () => {
	test('captures changes in documents opened after tracking starts', async () => {
		const tracker = new ChangeTracker(180);
		try {
			const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'before' });
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(0, 0, 0, 6), 'after');
			assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
			const changes = tracker.getChanges(getScopeKey(document.uri), 0);
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].originalText, 'before');
			assert.strictEqual(changes[0].currentText, 'after');
		} finally {
			tracker.dispose();
		}
	});

	test('records and coalesces changes to an open document', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'before\n' });
		const tracker = new ChangeTracker(180);
		tracker.seedDocument(document);
		try {
			const firstEdit = new vscode.WorkspaceEdit();
			firstEdit.replace(document.uri, new vscode.Range(0, 0, 0, 6), 'after');
			assert.strictEqual(await vscode.workspace.applyEdit(firstEdit), true);
			const secondEdit = new vscode.WorkspaceEdit();
			secondEdit.insert(document.uri, new vscode.Position(0, 5), ' again');
			assert.strictEqual(await vscode.workspace.applyEdit(secondEdit), true);

			const changes = tracker.getChanges(getScopeKey(document.uri), 0);
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].originalText, 'before\n');
			assert.strictEqual(changes[0].currentText, 'after again\n');
		} finally {
			tracker.dispose();
		}
	});

	test('reconstructs edits in separate regions after earlier text shifts', async () => {
		const initial = 'first\nmiddle\nlast\n';
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: initial });
		const tracker = new ChangeTracker(180);
		tracker.seedDocument(document);
		try {
			const firstEdit = new vscode.WorkspaceEdit();
			firstEdit.replace(document.uri, new vscode.Range(0, 0, 0, 5), 'a much longer first line');
			assert.strictEqual(await vscode.workspace.applyEdit(firstEdit), true);
			const finalLine = document.lineCount - 2;
			const secondEdit = new vscode.WorkspaceEdit();
			secondEdit.replace(document.uri, new vscode.Range(finalLine, 0, finalLine, 4), 'new');
			assert.strictEqual(await vscode.workspace.applyEdit(secondEdit), true);
			const changes = tracker.getChanges(getScopeKey(document.uri), 0);
			assert.strictEqual(changes.length, 2);
			assert.strictEqual(reconstructOriginal(document.getText(), changes), initial);
		} finally {
			tracker.dispose();
		}
	});
});
