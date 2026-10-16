import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { AccessFileSystemProvider } from '../AccessFileSystemProvider';
import {
	formatTableSql,
	parseTableSql,
	renameTableSql,
	sameTableIndexes,
	sameTableSchema,
	validateTableSql,
} from '../tableData';
import { getComCollectionCount } from '../comCollection';
import {
	isAccessSystemTable,
	isDaoHiddenOrSystem,
	isMsysHiddenOrSystem,
} from '../accessObjectFlags';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('activates and registers the workspace command', async () => {
		const extension = vscode.extensions.all.find(
			candidate => candidate.packageJSON.name === 'accessfs',
		);
		assert.ok(extension, 'accessfs extension should be available in the test host');
		assert.ok(
			fs.existsSync(path.join(extension.extensionPath, 'out', 'vbaLanguageServer', 'server.js')),
			'Access-FS should package its adapted VBA language server',
		);
		assert.ok(
			(extension.packageJSON.activationEvents as string[]).includes('onCommand:accessfs.addToWorkspace'),
			'accessfs.addToWorkspace should activate Access-FS when invoked',
		);
		assert.ok(
			!(extension.packageJSON.extensionPack as string[] | undefined)?.includes('NotisDataAnalytics.vba-lsp'),
			'Access-FS should not recommend the incompatible upstream VBA language server',
		);

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

	test('parses Access modules without VB_Name and navigates to module constants', async () => {
		const extension = vscode.extensions.all.find(
			candidate => candidate.packageJSON.name === 'accessfs',
		);
		assert.ok(extension, 'accessfs extension should be available in the test host');

		const client = new LanguageClient(
			'accessfs-vba-test',
			'Access-FS VBA Language Server Test',
			{
				module: path.join(extension.extensionPath, 'out', 'vbaLanguageServer', 'server.js'),
				transport: TransportKind.ipc,
			},
			{ documentSelector: [{ scheme: 'accessfs' }] },
		);
		const uri = 'accessfs://database/modules/Test.bas';
		const source = [
			'Option Compare Database',
			'',
			'Public Const X As String = "adsdsda"',
			'',
			'Public Sub hello()',
			'    MsgBox X',
			'End Sub',
		].join('\n');

		try {
			await client.start();
			const diagnosticsPromise = new Promise<{ message: string }[]>((resolve, reject) => {
				let subscription: vscode.Disposable;
				const timeout = setTimeout(() => {
					subscription.dispose();
					reject(new Error('Timed out waiting for VBA diagnostics.'));
				}, 5000);
				subscription = client.onNotification(
					'textDocument/publishDiagnostics',
					(params: { uri: string; diagnostics: { message: string }[] }) => {
						if (params.uri !== uri) {
							return;
						}
						clearTimeout(timeout);
						subscription.dispose();
						resolve(params.diagnostics);
					},
				);
			});
			await client.sendNotification('textDocument/didOpen', {
				textDocument: { uri, languageId: 'vba', version: 1, text: source },
			});
			const diagnostics = await diagnosticsPromise;
			assert.ok(
				diagnostics.every(diagnostic =>
					!diagnostic.message.includes('Module missing attribute VB_NAME')
					&& !diagnostic.message.includes("Duplicate declaration 'Unknown Module'")),
				'standard Access module source should not report synthetic module errors',
			);

			const definitions = await client.sendRequest('textDocument/definition', {
				textDocument: { uri },
				position: { line: 5, character: 11 },
			}) as { targetUri: string; targetSelectionRange: { start: { line: number } } }[] | null;
			assert.ok(definitions?.length, `the constant reference should have a definition; diagnostics: ${JSON.stringify(diagnostics)}`);
			assert.strictEqual(definitions[0].targetUri, uri);
			assert.strictEqual(definitions[0].targetSelectionRange.start.line, 2);

			const completionResponse = await client.sendRequest('textDocument/completion', {
				textDocument: { uri },
				position: { line: 5, character: 14 },
			}) as { items?: { label: string; detail?: string }[] } | { label: string; detail?: string }[] | null;
			const completions = Array.isArray(completionResponse)
				? completionResponse
				: completionResponse?.items ?? [];
			assert.ok(completions.some(item => item.label === 'X' && item.detail === 'Public Const'));
			assert.ok(completions.some(item => item.label === 'MsgBox' && item.detail === 'VBA/Access intrinsic'));
		} finally {
			await client.stop();
		}
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

	test('supports creating an empty SQL file for a new table', () => {
		const provider = new AccessFileSystemProvider();
		const uri = vscode.Uri.parse('accessfs:/tables/NewPeople.sql');

		assert.strictEqual(
			provider.stat(vscode.Uri.parse('accessfs:/tables')).permissions,
			undefined,
			'the tables directory should allow creating files',
		);
		provider.writeFile(uri, Buffer.alloc(0), { create: true, overwrite: true });
		assert.strictEqual(provider.stat(uri).type, vscode.FileType.File);
		assert.strictEqual(provider.readFile(uri).byteLength, 0);

		provider.delete(uri);
		assert.throws(() => provider.stat(uri));
		provider.dispose();
	});

	test('renames a pending table SQL file before it has been created in Access', () => {
		const provider = new AccessFileSystemProvider();
		const oldUri = vscode.Uri.parse('accessfs:/tables/NewPeople.sql');
		const newUri = vscode.Uri.parse('accessfs:/tables/RenamedPeople.sql');
		provider.writeFile(oldUri, Buffer.alloc(0), { create: true, overwrite: true });

		provider.rename(oldUri, newUri, { overwrite: false });

		assert.strictEqual(provider.stat(newUri).type, vscode.FileType.File);
		assert.strictEqual(provider.readFile(newUri).byteLength, 0);
		assert.throws(() => provider.stat(oldUri));
		provider.delete(newUri);
		provider.dispose();
	});

	test('formats table schema and rows as SQL and parses Access date values', () => {
		const columns = [
			{ name: 'Id', type: 4, attributes: 17, size: 4, decimalPlaces: 0, required: true },
			{ name: 'Name', type: 10, attributes: 32, size: 100, decimalPlaces: 0, required: false },
			{ name: 'Created', type: 8, attributes: 32, size: 8, decimalPlaces: 0, required: false },
		];
		const created = new Date('2026-10-15T12:00:00.000Z');
		const sql = formatTableSql('People', columns, [
			{ Id: 1, Name: "Ada's data", Created: { $accessfs: 'date', value: created.toISOString() } },
		]);
		const parsed = parseTableSql(sql);

		assert.match(sql, /CREATE TABLE \[People\]/);
		assert.match(sql, /INSERT INTO \[People\]/);
		assert.match(sql, /'Ada''s data'/);
		assert.strictEqual(parsed.tableName, 'People');
		assert.deepStrictEqual(parsed.rows, [[1, "Ada's data", created]]);
		assert.ok(sameTableSchema(columns, parsed.columns));
	});

	test('diagnoses table SQL without a leading CREATE TABLE statement', () => {
		const issues = validateTableSql('SELECT * FROM [People];', 'People');

		assert.strictEqual(issues.length, 1);
		assert.match(issues[0].message, /must start with a CREATE TABLE/i);
		assert.strictEqual(issues[0].start, 0);
	});

	test('diagnoses a CREATE TABLE name that does not match the filename', () => {
		const sql = 'CREATE TABLE [OtherPeople] ([Id] LONG);';
		const issues = validateTableSql(sql, 'People');

		assert.strictEqual(issues.length, 1);
		assert.match(issues[0].message, /must match the file name "People"/);
		assert.strictEqual(sql.slice(issues[0].start, issues[0].end), sql.slice(0, -1));
	});

	test('underlines an INSERT that omits a required CREATE TABLE column', () => {
		const sql = [
			'CREATE TABLE [People] ([Id] LONG NOT NULL, [Name] TEXT(30) NOT NULL);',
			'INSERT INTO [People] ([Id]) VALUES (1);',
		].join('\n');
		const issues = validateTableSql(sql, 'People');

		assert.strictEqual(issues.length, 1);
		assert.match(issues[0].message, /missing required field "Name"/);
		assert.strictEqual(sql.slice(issues[0].start, issues[0].end), 'INSERT INTO [People] ([Id]) VALUES (1)');
	});

	test('warns when an INSERT omits a nullable column from CREATE TABLE', () => {
		const sql = [
			'CREATE TABLE [People] ([Id] LONG NOT NULL, [Nickname] TEXT(30));',
			'INSERT INTO [People] ([Id]) VALUES (1);',
		].join('\n');
		const issues = validateTableSql(sql, 'People');

		assert.strictEqual(issues.length, 1);
		assert.strictEqual(issues[0].severity, 'warning');
		assert.match(issues[0].message, /Missing: Nickname/);
		assert.strictEqual(sql.slice(issues[0].start, issues[0].end), 'INSERT INTO [People] ([Id]) VALUES (1)');
	});

	test('formats and parses primary, unique, and regular indexes', () => {
		const columns = [
			{ name: 'Id', type: 4, attributes: 17, size: 4, decimalPlaces: 0, required: true },
			{ name: 'Name', type: 10, attributes: 32, size: 100, decimalPlaces: 0, required: false },
			{ name: 'Created', type: 8, attributes: 32, size: 8, decimalPlaces: 0, required: false },
		];
		const indexes = [
			{
				name: 'PrimaryKey',
				primary: true,
				unique: true,
				fields: [{ name: 'Id', descending: false }],
			},
			{
				name: 'NameDateUnique',
				primary: false,
				unique: true,
				fields: [
					{ name: 'Name', descending: false },
					{ name: 'Created', descending: true },
				],
			},
			{
				name: 'CreatedIndex',
				primary: false,
				unique: false,
				fields: [{ name: 'Created', descending: false }],
			},
		];
		const sql = formatTableSql('People', columns, [], indexes);
		const parsed = parseTableSql(sql);

		assert.match(sql, /CREATE UNIQUE INDEX \[PrimaryKey\] ON \[People\] \(\[Id\]\) WITH PRIMARY;/);
		assert.match(sql, /CREATE UNIQUE INDEX \[NameDateUnique\]/);
		assert.match(sql, /CREATE INDEX \[CreatedIndex\]/);
		assert.ok(sameTableIndexes(indexes, parsed.indexes));
		assert.strictEqual(parsed.indexStatements.length, indexes.length);
	});

	test('renames copied table SQL to the destination filename', () => {
		const sourceSql = [
			'CREATE TABLE [People] ([Id] COUNTER NOT NULL, [Name] TEXT(40));',
			'CREATE UNIQUE INDEX [PrimaryKey] ON [People] ([Id]) WITH PRIMARY;',
			"INSERT INTO [People] ([Id], [Name]) VALUES (1, 'Ada');",
		].join('\n');
		const renamed = parseTableSql(renameTableSql(sourceSql, 'PeopleCopy'));

		assert.strictEqual(renamed.tableName, 'PeopleCopy');
		assert.deepStrictEqual(renamed.rows, [[1, 'Ada']]);
		assert.strictEqual(renamed.indexes[0].primary, true);
		assert.match(renamed.indexStatements[0], /ON \[PeopleCopy\]/);
	});

	test('rejects an index that references an unknown table field', () => {
		assert.throws(
			() => parseTableSql([
				'CREATE TABLE [People] ([Id] LONG);',
				'CREATE INDEX [NameIndex] ON [People] ([Name]);',
			].join('\n')),
			/index references unknown field "Name"/i,
		);
	});

	test('accepts numeric AutoNumber values for rows to be inserted', () => {
		const columns = [
			{ name: 'Id', type: 4, attributes: 17, size: 4, decimalPlaces: 0, required: true },
			{ name: 'Name', type: 10, attributes: 32, size: 100, decimalPlaces: 0, required: false },
		];
		const sql = formatTableSql('People', columns, [{ Id: 932, Name: 'New row' }]);

		assert.deepStrictEqual(parseTableSql(sql).rows, [[932, 'New row']]);
	});

	test('parses a changed table schema and reports it as different', () => {
		const columns = [{ name: 'Id', type: 4, attributes: 17, size: 4, decimalPlaces: 0, required: true }];
		const changedSchema = [
			'CREATE TABLE [People] (',
			'    [Id] SHORT NOT NULL',
			');',
		].join('\n');
		const parsed = parseTableSql(changedSchema);

		assert.strictEqual(parsed.tableName, 'People');
		assert.strictEqual(parsed.columns[0].type, 3);
		assert.strictEqual(sameTableSchema(columns, parsed.columns), false);
	});

	test('does not treat unrepresented fixed-field metadata as a schema change', () => {
		const currentColumns = [
			{ name: 'Amount', type: 5, attributes: 32, size: 8, decimalPlaces: 4, required: false },
		];
		const parsed = parseTableSql('CREATE TABLE [Ledger] ([Amount] CURRENCY);');

		assert.ok(sameTableSchema(currentColumns, parsed.columns));
	});

	test('parses a new table definition and rows that omit an AutoNumber field', () => {
		const parsed = parseTableSql([
			'CREATE TABLE [NewPeople] (',
			'    [Id] COUNTER NOT NULL,',
			'    [Name] TEXT(80) NOT NULL',
			');',
			'INSERT INTO [NewPeople] ([Name]) VALUES (\'Ada\');',
		].join('\n'));

		assert.strictEqual(parsed.tableName, 'NewPeople');
		assert.deepStrictEqual(parsed.rows, [[null, 'Ada']]);
		assert.strictEqual(parsed.columns[1].size, 80);
	});

	test('keeps numeric precision commas inside a field definition', () => {
		const parsed = parseTableSql('CREATE TABLE [Ledger] ([Amount] NUMERIC(12, 2));');

		assert.strictEqual(parsed.columns.length, 1);
		assert.strictEqual(parsed.columns[0].size, 12);
		assert.strictEqual(parsed.columns[0].decimalPlaces, 2);
	});

	test('parses escaped closing brackets in table and field names', () => {
		const columns = [
			{ name: 'Value]Text', type: 10, attributes: 32, size: 10, decimalPlaces: 0, required: false },
		];
		const sql = formatTableSql('People]Archive', columns, [{ 'Value]Text': 'Ada' }]);
		const parsed = parseTableSql(sql);

		assert.strictEqual(parsed.tableName, 'People]Archive');
		assert.strictEqual(parsed.columns[0].name, 'Value]Text');
		assert.deepStrictEqual(parsed.rows, [['Ada']]);
	});

	test('rejects invalid row values before a schema rebuild can start', () => {
		assert.throws(
			() => parseTableSql([
				'CREATE TABLE [People] ([Name] TEXT(3));',
				"INSERT INTO [People] ([Name]) VALUES ('Too long');",
			].join('\n')),
			/invalid value for field "Name"/,
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

	test('recognizes DAO and MSys hidden/system flags', () => {
		assert.strictEqual(isDaoHiddenOrSystem(0), false);
		assert.strictEqual(isDaoHiddenOrSystem(1), true);
		assert.strictEqual(isDaoHiddenOrSystem(-2147483648), true);
		assert.strictEqual(isMsysHiddenOrSystem(0), false);
		assert.strictEqual(isMsysHiddenOrSystem(1), true);
		assert.strictEqual(isMsysHiddenOrSystem(2), true);
	});

	test('recognizes Access system tables by their reserved MSys names', () => {
		assert.strictEqual(isAccessSystemTable('MSysACEs'), true);
		assert.strictEqual(isAccessSystemTable('MSysObjects'), true);
		assert.strictEqual(isAccessSystemTable('MSysAccessStorage'), true);
		assert.strictEqual(isAccessSystemTable('MSysNameMap'), true);
		assert.strictEqual(isAccessSystemTable('UserData'), false);
		assert.strictEqual(isAccessSystemTable('USysConfig'), false);
	});

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
