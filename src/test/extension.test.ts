import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { AccessFileSystemProvider } from '../AccessFileSystemProvider';
import { parseTableData } from '../tableData';
import { getComCollectionCount } from '../comCollection';
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
				['classes', vscode.FileType.Directory],
				['macros', vscode.FileType.Directory],
			],
		);
		provider.dispose();
	});

	test('parses a table snapshot and restores Access date values', () => {
		const columns = [
			{ name: 'Id', type: 4, attributes: 17 },
			{ name: 'Name', type: 10, attributes: 32 },
			{ name: 'Created', type: 8, attributes: 32 },
		];
		const date = '2026-10-15T12:00:00.000Z';
		const rows = parseTableData(JSON.stringify({
			format: 'accessfs-table-v1',
			table: 'People',
			columns,
			rows: [{ Id: 1, Name: 'Ada', Created: { $accessfs: 'date', value: date } }],
		}), 'People', columns);

		assert.deepStrictEqual(rows, [[1, 'Ada', new Date(date)]]);
	});

	test('rejects table snapshots whose schema does not match Access', () => {
		const columns = [{ name: 'Id', type: 4, attributes: 17 }];
		const content = JSON.stringify({
			format: 'accessfs-table-v1',
			table: 'People',
			columns: [{ name: 'Id', type: 3, attributes: 17 }],
			rows: [{ Id: 1 }],
		});

		assert.throws(
			() => parseTableData(content, 'People', columns),
			/The schema in the table document does not match/,
		);
	});

	test('reads COM collection counts from properties and methods', () => {
		assert.strictEqual(getComCollectionCount({ Count: 3 }, 'test'), 3);
		assert.strictEqual(getComCollectionCount({ Count: () => 4 }, 'test'), 4);
		assert.strictEqual(getComCollectionCount({ count: 5 }, 'test'), 5);
	});

	test('does not treat a missing COM collection count as an empty collection', () => {
		assert.throws(
			() => getComCollectionCount({}, 'table fields'),
			/Could not read the item count from the Access table fields collection/,
		);
	});

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
