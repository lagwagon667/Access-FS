import * as vscode from 'vscode';
import { AccessBridge, type AccessInstance } from './AccessBridge';
import { renameTableSql } from './tableData';

const categories = {
    tables: '$access.CurrentData.AllTables',
    queries: '$access.CurrentData.AllQueries',
    forms: '$access.CurrentProject.AllForms',
    reports: '$access.CurrentProject.AllReports',
    modules: '$access.CurrentProject.AllModules',
    classes: '$access.CurrentProject.AllModules',
    macros: '$access.CurrentProject.AllMacros',
} as const;

export type Category = keyof typeof categories;

export interface AccessObjectSearchResult {
    uri: vscode.Uri;
    category: Category;
    objectName: string;
    line?: number;
    preview: string;
}

export class AccessFileSystemProvider implements vscode.FileSystemProvider, vscode.FileDecorationProvider, vscode.Disposable {
    private readonly changedEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    private readonly decorationsChangedEmitter = new vscode.EventEmitter<vscode.Uri[]>();
    readonly onDidChangeFile = this.changedEmitter.event;
    readonly onDidChangeFileDecorations = this.decorationsChangedEmitter.event;
    private readonly timestamp = Date.now();
    private readonly bridge = new AccessBridge();
    private readonly fileMtimes = new Map<string, number>();
    private readonly hiddenOrSystemFiles = new Set<string>();
    private readonly pendingTableFiles = new Map<string, string>();

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: readonly string[] }): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    dispose(): void {
        this.changedEmitter.dispose();
        this.decorationsChangedEmitter.dispose();
    }

    connectTo(instance: AccessInstance): void {
        this.bridge.connectTo(instance);
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
            return category === 'tables' ? this.directoryStat(true) : this.directoryStat();
        }
        if (parts.length !== 2) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        if (category === 'tables' && this.pendingTableFiles.has(this.fileKey(uri))) {
            return {
                type: vscode.FileType.File,
                ctime: this.timestamp,
                mtime: this.timestamp,
                size: 0,
            };
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

        const names = this.bridge.getNames(category);
        if (category === 'tables') {
            for (const [key, name] of this.pendingTableFiles) {
                if (key.startsWith(`${this.fileKey(uri)}/`)) {
                    names.push(name);
                }
            }
        }
        const changedDecorations: vscode.Uri[] = [];
        for (const name of names) {
            const objectUri = vscode.Uri.joinPath(uri, `${name}.${this.getExtension(category)}`);
            const key = this.fileKey(objectUri);
            if (this.pendingTableFiles.has(key)) {
                this.hiddenOrSystemFiles.delete(key);
                changedDecorations.push(objectUri);
                continue;
            }
            try {
                if (this.bridge.isHiddenOrSystem(category, name)) {
                    this.hiddenOrSystemFiles.add(key);
                } else {
                    this.hiddenOrSystemFiles.delete(key);
                }
            } catch (error) {
                console.warn(`Could not determine whether Access object "${name}" is hidden or a system object:`, error);
                this.hiddenOrSystemFiles.delete(key);
            }
            changedDecorations.push(objectUri);
        }
        if (changedDecorations.length) {
            this.decorationsChangedEmitter.fire(changedDecorations);
        }
        return names.map(name => [`${name}.${this.getExtension(category)}`, vscode.FileType.File]);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (!this.hiddenOrSystemFiles.has(this.fileKey(uri))) {
            return undefined;
        }
        return new vscode.FileDecoration(
            undefined,
            'Hidden or system Access object',
            new vscode.ThemeColor('disabledForeground'),
        );
    }

    readFile(uri: vscode.Uri): Uint8Array {
        if (this.pendingTableFiles.has(this.fileKey(uri))) {
            return Buffer.alloc(0);
        }
        const { category, name } = this.getCategoryAndName(uri);
        return this.getObjectContent(category, name);
    }

    searchObjects(query: string): AccessObjectSearchResult[] {
        const trimmedQuery = query.trim();
        if (!trimmedQuery) {
            return [];
        }
        const searchTerm = trimmedQuery.toLowerCase();
        const results: AccessObjectSearchResult[] = [];

        for (const category of Object.keys(categories) as Category[]) {
            for (const objectName of this.bridge.getNames(category)) {
                const uri = vscode.Uri.from({
                    scheme: 'accessfs',
                    path: `/${category}/${objectName}.${this.getExtension(category)}`,
                });
                if (objectName.toLowerCase().includes(searchTerm)) {
                    results.push({
                        uri,
                        category,
                        objectName,
                        preview: objectName,
                    });
                }

                if (category !== 'modules') {
                    continue;
                }

                const source = this.bridge.read(category, objectName);
                if (source === undefined) {
                    continue;
                }
                const lines = this.normalizeLineEndings(source).split('\n');
                lines.forEach((line, index) => {
                    if (line.toLowerCase().includes(searchTerm)) {
                        results.push({
                            uri,
                            category,
                            objectName,
                            line: index + 1,
                            preview: line.trim() || '(blank line)',
                        });
                    }
                });
            }
        }

        return results;
    }

    createDirectory(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
        const { category, name } = this.getCategoryAndName(uri);

        const extension = `.${this.getExtension(category)}`;
        if (!name.endsWith(extension)) {
            throw vscode.FileSystemError.FileNotFound(name);
        }
        const accessObjectName = name.slice(0, -extension.length);

        switch (category) {
            case 'tables':
                const tableSql = new TextDecoder('utf-8').decode(content);
                const fileKey = this.fileKey(uri);
                const isPendingTable = this.pendingTableFiles.has(fileKey);
                const isExclusiveCreate = options.create && !options.overwrite;
                const isNewTable = isExclusiveCreate || isPendingTable;
                if (options.create && !tableSql.trim()) {
                    this.pendingTableFiles.set(fileKey, accessObjectName);
                    this.changedEmitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
                    return;
                }
                if (!tableSql.trim() && isPendingTable) {
                    return;
                }

                const sqlToWrite = options.create || isPendingTable
                    ? renameTableSql(tableSql, accessObjectName)
                    : tableSql;
                this.bridge.write(category, accessObjectName, sqlToWrite, isNewTable);
                this.pendingTableFiles.delete(fileKey);

                const actualTableSql = this.bridge.read(category, accessObjectName);
                if (actualTableSql === undefined) {
                    throw vscode.FileSystemError.Unavailable(
                        `Could not read back Access table "${accessObjectName}" after saving.`,
                    );
                }

                this.markFileChanged(
                    uri,
                    isPendingTable ? vscode.FileChangeType.Changed : (
                        isNewTable ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed
                    ),
                );
                if (this.normalizeLineEndings(sqlToWrite) !== this.normalizeLineEndings(actualTableSql)) {
                    setTimeout(() => {
                        void this.reconcileOpenDocument(uri, sqlToWrite, actualTableSql).catch(error => {
                            const message = error instanceof Error ? error.message : String(error);
                            console.error(`Failed to refresh ${uri.toString()} after Access generated table values:`, error);
                            void vscode.window.showErrorMessage(
                                `Failed to refresh "${uri.path}" from Access: ${message}`,
                            );
                        });
                    }, 0);
                }
                return;
            case 'modules':
            case 'classes':
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
                    this.markFileChanged(uri);
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
        const { category, name } = this.getCategoryAndName(uri);
        if (category === 'tables' && this.pendingTableFiles.delete(this.fileKey(uri))) {
            this.changedEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
            return;
        }
        const extension = `.${this.getExtension(category)}`;
        if (!name.endsWith(extension)) {
            throw vscode.FileSystemError.FileNotFound(name);
        }
        const accessObjectName = name.slice(0, -extension.length);
        this.bridge.delete(category, accessObjectName);
        if (category === 'tables') {
            this.fileMtimes.delete(this.fileKey(uri));
            this.hiddenOrSystemFiles.delete(this.fileKey(uri));
            this.changedEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
        }
    }

    rename(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
        _options: { overwrite: boolean },
    ): void {
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

        if (newCategory === 'tables') {
            const oldKey = this.fileKey(oldUri);
            const newKey = this.fileKey(newUri);
            const pendingName = this.pendingTableFiles.get(oldKey);
            if (pendingName !== undefined) {
                this.pendingTableFiles.delete(oldKey);
                this.pendingTableFiles.set(newKey, newAccessObjectName);
            } else {
                this.bridge.rename(newCategory, oldAccessObjectName, newAccessObjectName);
            }
            this.fileMtimes.delete(oldKey);
            this.hiddenOrSystemFiles.delete(oldKey);
            this.changedEmitter.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri },
            ]);
            return;
        }

        this.bridge.rename(newCategory, oldAccessObjectName, newAccessObjectName);
    }

    private pathParts(uri: vscode.Uri): string[] {
        return uri.path.split('/').filter(Boolean);
    }

    private fileKey(uri: vscode.Uri): string {
        return uri.toString().toLowerCase();
    }

    private markFileChanged(
        uri: vscode.Uri,
        type: vscode.FileChangeType = vscode.FileChangeType.Changed,
    ): void {
        const key = this.fileKey(uri);
        this.fileMtimes.set(
            key,
            Math.max(Date.now(), (this.fileMtimes.get(key) ?? this.timestamp) + 1),
        );
        this.changedEmitter.fire([{ type, uri }]);
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

    private directoryStat(writable = false): vscode.FileStat {
        return {
            type: vscode.FileType.Directory,
            ctime: this.timestamp,
            mtime: this.timestamp,
            size: 0,
            permissions: writable ? undefined : vscode.FilePermission.Readonly,
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
                return 'bas';
            case 'classes':
                return 'cls';
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
            case 'tables':
                const tableContent = this.bridge.read(category, name);
                if (tableContent === undefined) {
                    throw vscode.FileSystemError.FileNotFound(fileName);
                }
                return Buffer.from(tableContent, 'utf8');
            case 'modules':
            case 'classes':
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
