import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { AccessFileSystemProvider } from '../AccessFileSystemProvider';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('activates and registers the workspace command', async () => {
		const extension = vscode.extensions.all.find(
			candidate => candidate.packageJSON.name === 'accessfs',
		);
		assert.ok(extension, 'accessfs extension should be available in the test host');

		await extension.activate();
		assert.ok(
			(await vscode.commands.getCommands(true)).includes('accessfs.addToWorkspace'),
			'accessfs.addToWorkspace should be registered after activation',
		);
		assert.ok(
			(await vscode.commands.getCommands(true)).includes('accessfs.searchObjects'),
			'accessfs.searchObjects should be registered after activation',
		);
		assert.strictEqual(
			require.cache[require.resolve('winax')],
			undefined,
			'winax should not load until an Access object is requested',
		);
	});

	test('lists the Access object categories at the filesystem root', () => {
		const provider = new AccessFileSystemProvider();
		assert.deepStrictEqual(
			provider.readDirectory(vscode.Uri.parse('accessfs:/')),
			[
				['tables', vscode.FileType.Directory],
				['queries', vscode.FileType.Directory],
				['forms', vscode.FileType.Directory],
				['reports', vscode.FileType.Directory],
				['modules', vscode.FileType.Directory],
				['macros', vscode.FileType.Directory],
			],
		);
		provider.dispose();
	});

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
