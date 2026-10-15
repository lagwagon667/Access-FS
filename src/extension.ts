// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { AccessFileSystemProvider } from './AccessFileSystemProvider';
import { AccessBridge } from './AccessBridge';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "accessfs" is now active!');
	const provider = new AccessFileSystemProvider();
	const fsProvider = vscode.workspace.registerFileSystemProvider(
		'accessfs',
		provider,
		{ isCaseSensitive: false, isReadonly: false },
	);
	context.subscriptions.push(new vscode.Disposable(() => {
		fsProvider.dispose();
		provider.dispose();
	}));
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

// This method is called when your extension is deactivated
export function deactivate() { }
