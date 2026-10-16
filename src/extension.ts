// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { AccessFileSystemProvider } from './AccessFileSystemProvider';
import { AccessBridge } from './AccessBridge';
import { validateTableSql } from './tableData';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "accessfs" is now active!');
	if (vscode.extensions.getExtension('NotisDataAnalytics.vba-lsp')) {
		void vscode.window.showWarningMessage(
			'NotisDataAnalytics.vba-lsp is incompatible with Access-FS virtual VBA files and can crash while scanning the accessfs: workspace. Disable it for this workspace or uninstall it; Access-FS includes its own VBA language server.',
		);
	}
	const provider = new AccessFileSystemProvider();
	const fsProvider = vscode.workspace.registerFileSystemProvider(
		'accessfs',
		provider,
		{ isCaseSensitive: false, isReadonly: false },
	);
	const decorationProvider = vscode.window.registerFileDecorationProvider(provider);
	const tableSqlDiagnostics = vscode.languages.createDiagnosticCollection('accessfs-table-sql');
	let vbaLanguageClient: LanguageClient | undefined;
	let startingVbaLanguageClient: Promise<void> | undefined;
	context.subscriptions.push(decorationProvider, new vscode.Disposable(() => {
		fsProvider.dispose();
		provider.dispose();
	}), tableSqlDiagnostics);

	const startVbaLanguageClient = (): Promise<void> => {
		if (vbaLanguageClient) {
			return Promise.resolve();
		}
		if (startingVbaLanguageClient) {
			return startingVbaLanguageClient;
		}

		startingVbaLanguageClient = (async () => {
			const serverModule = context.asAbsolutePath(path.join('out', 'vbaLanguageServer', 'server.js'));
			const client = new LanguageClient(
				'accessfs-vba',
				'Access-FS VBA Language Server',
				{ module: serverModule, transport: TransportKind.ipc },
				{
					documentSelector: [{ scheme: 'accessfs', pattern: '**/*.{bas,cls,frm}' }],
				},
			);
			vbaLanguageClient = client;
			context.subscriptions.push(client);
			try {
				await client.start();
			} catch (error) {
				client.dispose();
				vbaLanguageClient = undefined;
				throw error;
			}
		})().finally(() => {
			startingVbaLanguageClient = undefined;
		});
		return startingVbaLanguageClient;
	};
	const startVbaLanguageClientForDocument = (document: vscode.TextDocument) => {
		if (isAccessVbaDocument(document)) {
			void startVbaLanguageClient().catch(error => {
				const message = error instanceof Error ? error.message : String(error);
				console.error('Could not start the VBA language server for Access-FS documents:', error);
				void vscode.window.showErrorMessage(`Could not start the Access-FS VBA language server: ${message}`);
			});
		}
	};
	const vbaDocumentOpenListener = vscode.workspace.onDidOpenTextDocument(startVbaLanguageClientForDocument);
	context.subscriptions.push(vbaDocumentOpenListener);
	for (const document of vscode.workspace.textDocuments) {
		startVbaLanguageClientForDocument(document);
	}

	const updateTableSqlDiagnostics = (document: vscode.TextDocument) => {
		if (!isTableSqlDocument(document.uri)) {
			return;
		}
		const fileName = document.uri.path.split('/').pop() ?? '';
		const tableName = fileName.replace(/\.sql$/i, '');
		const diagnostics = validateTableSql(document.getText(), tableName).map(issue => {
			const diagnostic = new vscode.Diagnostic(
				new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)),
				issue.message,
				issue.severity === 'error'
					? vscode.DiagnosticSeverity.Error
					: vscode.DiagnosticSeverity.Warning,
			);
			diagnostic.source = 'Access-FS table SQL';
			return diagnostic;
		});
		tableSqlDiagnostics.set(document.uri, diagnostics);
	};
	const documentOpenListener = vscode.workspace.onDidOpenTextDocument(updateTableSqlDiagnostics);
	const documentChangeListener = vscode.workspace.onDidChangeTextDocument(event => {
		updateTableSqlDiagnostics(event.document);
	});
	const documentCloseListener = vscode.workspace.onDidCloseTextDocument(document => {
		tableSqlDiagnostics.delete(document.uri);
	});
	context.subscriptions.push(documentOpenListener, documentChangeListener, documentCloseListener);
	for (const document of vscode.workspace.textDocuments) {
		updateTableSqlDiagnostics(document);
	}
	const command = vscode.commands.registerCommand('accessfs.addToWorkspace', async () => {
		const root = vscode.Uri.parse('accessfs:/');
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		const rootAlreadyAdded = workspaceFolders.some(folder => folder.uri.toString() === root.toString());

		let instances;
		try {
			instances = AccessBridge.getAvailableInstances();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(message);
			return;
		}
		if (instances.length === 0) {
			void vscode.window.showInformationMessage('No open Microsoft Access instances were found.');
			return;
		}

		const selectedInstance = await vscode.window.showQuickPick(
			instances.map(instance => ({
				label: instance.databaseName,
				instance,
			})),
			{ placeHolder: 'Select the open Access database to connect to' },
		);
		if (!selectedInstance) {
			return;
		}

		try {
			provider.connectTo(selectedInstance.instance);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Could not connect to "${selectedInstance.label}": ${message}`);
			return;
		}

		if (rootAlreadyAdded) {
			return;
		}

		if (!vscode.workspace.updateWorkspaceFolders(workspaceFolders.length, 0, {
			uri: root,
			name: selectedInstance.label,
		})) {
			void vscode.window.showErrorMessage('Could not add the Access filesystem to this workspace.');
		}
	});

	context.subscriptions.push(command);

	const searchCommand = vscode.commands.registerCommand('accessfs.searchObjects', async () => {
		const query = await vscode.window.showInputBox({
			prompt: 'Search Access object names and module source',
			placeHolder: 'Enter text to search',
			ignoreFocusOut: true,
		});
		if (!query?.trim()) {
			return;
		}

		let results;
		try {
			results = provider.searchObjects(query.trim());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Could not search Access objects: ${message}`);
			return;
		}

		if (results.length === 0) {
			void vscode.window.showInformationMessage(`No Access objects matched "${query}".`);
			return;
		}

		const selectedResult = await vscode.window.showQuickPick(
			results.map(result => ({
				label: result.objectName,
				description: result.line ? `${result.category}, line ${result.line}` : result.category,
				detail: result.preview,
				result,
			})),
			{ placeHolder: `${results.length} Access search result(s)` },
		);
		if (!selectedResult) {
			return;
		}

		try {
			const document = await vscode.workspace.openTextDocument(selectedResult.result.uri);
			const editor = await vscode.window.showTextDocument(document);
			if (selectedResult.result.line) {
				const position = new vscode.Position(selectedResult.result.line - 1, 0);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Could not open "${selectedResult.result.objectName}": ${message}`);
		}
	});
	context.subscriptions.push(searchCommand);
}

function isTableSqlDocument(uri: vscode.Uri): boolean {
	if (!uri.path.toLowerCase().endsWith('.sql')) {
		return false;
	}
	const pathParts = uri.path.split('/').filter(Boolean);
	return pathParts.length > 1 && pathParts[pathParts.length - 2].toLowerCase() === 'tables';
}

function isAccessVbaDocument(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'accessfs'
		&& (document.languageId === 'vba' || /\.(cls|bas|frm)$/i.test(document.uri.path));
}

// This method is called when your extension is deactivated
export function deactivate() { }
