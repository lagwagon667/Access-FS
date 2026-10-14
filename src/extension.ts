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
}

// This method is called when your extension is deactivated
export function deactivate() { }
