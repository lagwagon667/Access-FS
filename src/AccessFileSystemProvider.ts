import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import { AccessBridge } from './AccessBridge';

const categories = {
    tables: '$access.CurrentData.AllTables',
    queries: '$access.CurrentData.AllQueries',
    forms: '$access.CurrentProject.AllForms',
    reports: '$access.CurrentProject.AllReports',
    modules: '$access.CurrentProject.AllModules',
    macros: '$access.CurrentProject.AllMacros',
} as const;

export type Category = keyof typeof categories;

export class AccessFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
    private readonly changedEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changedEmitter.event;
    private readonly timestamp = Date.now();
    private readonly bridge = new AccessBridge();
    private readonly fileMtimes = new Map<string, number>();

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: readonly string[] }): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    dispose(): void {
        this.changedEmitter.dispose();
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const parts = this.pathParts(uri);
        if (parts.length === 0) {
            return this.directoryStat();
        }

        const category = this.getCategory(parts[0]);
        if (!category) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        if (parts.length === 1) {
            return this.directoryStat();
        }
        if (parts.length !== 2) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        const content = this.getObjectContent(category, parts[1]);

        return {
            type: vscode.FileType.File,
            ctime: this.timestamp,
            mtime: this.fileMtimes.get(this.fileKey(uri)) ?? this.timestamp,
            size: content.byteLength,
        };
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        const parts = this.pathParts(uri);
        if (parts.length === 0) {
            return Object.keys(categories).map(name => [name, vscode.FileType.Directory]);
        }

        const category = this.getCategory(parts[0]);
        if (!category) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        if (parts.length !== 1) {
            if (parts.length === 2) {
                this.getObjectContent(category, parts[1]);
            }
            throw vscode.FileSystemError.FileNotADirectory(uri);
        }

        return this.bridge.getNames(category).map(name => [`${name}.${this.getExtension(category)}`, vscode.FileType.File]);
    }

    readFile(uri: vscode.Uri): Uint8Array {
        const { category, name } = this.getCategoryAndName(uri);
        return this.getObjectContent(category, name);
    }

    createDirectory(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    writeFile(uri: vscode.Uri, content: Uint8Array): void {
        const { category, name } = this.getCategoryAndName(uri);

        const extension = `.${this.getExtension(category)}`;
        if (!name.endsWith(extension)) {
            throw vscode.FileSystemError.FileNotFound(name);
        }
        const accessObjectName = name.slice(0, -extension.length);

        switch (category) {
            case 'modules':
                const code = new TextDecoder('utf-8').decode(content);
                this.bridge.write(category, accessObjectName, code);

                const actualSource = this.bridge.read(category, accessObjectName);
                if (actualSource === undefined) {
                    throw vscode.FileSystemError.Unavailable(
                        `Could not read back Access module "${accessObjectName}" after saving.`,
                    );
                }

                const normalizedSource = this.normalizeLineEndings(actualSource);
                if (this.normalizeLineEndings(code) !== normalizedSource) {
                    const key = this.fileKey(uri);
                    this.fileMtimes.set(
                        key,
                        Math.max(Date.now(), (this.fileMtimes.get(key) ?? this.timestamp) + 1),
                    );
                    this.changedEmitter.fire([
                        {
                            type: vscode.FileChangeType.Changed,
                            uri
                        }
                    ]);
                    setTimeout(() => {
                        void this.reconcileOpenDocument(uri, code, normalizedSource).catch(error => {
                            const message = error instanceof Error ? error.message : String(error);
                            console.error(`Failed to refresh ${uri.toString()} after Access normalized its source:`, error);
                            void vscode.window.showErrorMessage(
                                `Failed to refresh "${uri.path}" from Access: ${message}`,
                            );
                        });
                    }, 0);
                }
                return;
        }
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    delete(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
        const { category: oldCategory, name: oldName } = this.getCategoryAndName(oldUri);
        const { category: newCategory, name: newName } = this.getCategoryAndName(newUri);

        if (oldCategory !== newCategory) {
            throw vscode.FileSystemError.Unavailable(`Cannot rename between different categories ${oldCategory} and ${newCategory}`);
        }

        const extension = `.${this.getExtension(newCategory)}`;
        if (!oldName.endsWith(extension)) {
            throw vscode.FileSystemError.FileNotFound(oldName);
        }

        const oldAccessObjectName = oldName.slice(0, -extension.length);
        const newAccessObjectName = newName.slice(0, -extension.length);

        this.bridge.rename(newCategory, oldAccessObjectName, newAccessObjectName);
    }

    private pathParts(uri: vscode.Uri): string[] {
        return uri.path.split('/').filter(Boolean);
    }

    private fileKey(uri: vscode.Uri): string {
        return uri.toString().toLowerCase();
    }

    private async reconcileOpenDocument(
        uri: vscode.Uri,
        submittedContent: string,
        normalizedContent: string,
    ): Promise<void> {
        const document = vscode.workspace.textDocuments.find(
            candidate => this.fileKey(candidate.uri) === this.fileKey(uri),
        );
        if (!document || document.getText() !== submittedContent) {
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            normalizedContent,
        );
        if (!await vscode.workspace.applyEdit(edit)) {
            void vscode.window.showErrorMessage(
                `Could not update the editor with the normalized contents of "${uri.path}".`,
            );
            return;
        }

        if (document.isDirty && !await document.save()) {
            void vscode.window.showErrorMessage(
                `Could not save the normalized contents of "${uri.path}" back to Access.`,
            );
        }
    }

    private getCategory(name: string): Category | undefined {
        const normalizedName = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(categories, normalizedName)
            ? normalizedName as Category
            : undefined;
    }

    private directoryStat(): vscode.FileStat {
        return {
            type: vscode.FileType.Directory,
            ctime: this.timestamp,
            mtime: this.timestamp,
            size: 0,
            permissions: vscode.FilePermission.Readonly,
        };
    }

    private getExtension(category: Category): string {
        switch (category) {
            case 'tables':
                return 'sql';
            case 'queries':
                return 'sql';
            case 'forms':
                return 'form';
            case 'reports':
                return 'rpt';
            case 'modules':
                return 'vb';
            case 'macros':
                return 'macro';
            default:
                throw new Error(`Unhandled category: ${category}`);
        }
    }

    private getCategoryAndName(uri: vscode.Uri): { category: Category; name: string } {
        const parts = this.pathParts(uri);
        if (parts.length === 0) {
            throw vscode.FileSystemError.FileIsADirectory(uri);
        }
        const category = this.getCategory(parts[0]);
        if (parts.length === 1 && category) {
            throw vscode.FileSystemError.FileIsADirectory(uri);
        }
        if (parts.length !== 2 || !category) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return { category, name: parts[1] };
    }

    private getObjectContent(category: Category, fileName: string): Uint8Array {
        const extension = `.${this.getExtension(category)}`;
        if (!fileName.endsWith(extension)) {
            throw vscode.FileSystemError.FileNotFound(fileName);
        }
        const name = fileName.slice(0, -extension.length);

        switch (category) {
            case 'modules':
                const content = this.bridge.read(category, name);
                if (!content) {
                    throw vscode.FileSystemError.FileNotFound(fileName);
                }
                return Buffer.from(this.normalizeLineEndings(content), 'utf8');
        }

        const content = `Name: ${name}\nCategory: ${category}\n\nThis is a placeholder for the content of the Access object.`;
        return Buffer.from(`${content}\n`, 'utf8');
    }

    private normalizeLineEndings(content: string): string {
        return content.replace(/\r\n?/g, '\n');
    }
}
