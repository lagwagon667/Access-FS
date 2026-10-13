import * as vscode from 'vscode';
import { spawnSync } from 'child_process';

const categories = {
    tables: '$access.CurrentData.AllTables',
    queries: '$access.CurrentData.AllQueries',
    forms: '$access.CurrentProject.AllForms',
    reports: '$access.CurrentProject.AllReports',
    modules: '$access.CurrentProject.AllModules',
    macros: '$access.CurrentProject.AllMacros',
} as const;
type Category = keyof typeof categories;

export class AccessFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
    private readonly changedEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changedEmitter.event;
    private readonly timestamp = Date.now();

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
            mtime: this.timestamp,
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

        return this.getNames(category).map(name => [`${name}.${this.getExtension(category)}`, vscode.FileType.File]);
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


        switch (category) {
            case 'modules':
                this.setCodeModuleContent(category, name, content.toString());
                return;
        }
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    delete(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    rename(oldUri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(oldUri);
    }

    private pathParts(uri: vscode.Uri): string[] {
        return uri.path.split('/').filter(Boolean);
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

    private getNames(category: Category): string[] {
        if (process.platform !== 'win32') {
            throw vscode.FileSystemError.Unavailable('Reading Access objects requires Windows.');
        }

        const script = [
            '$ErrorActionPreference = "Stop"',
            'try {',
            '  $access = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Access.Application")',
            `  $collection = ${categories[category]}`,
            '  $names = @()',
            '  for ($index = 0; $index -lt $collection.Count; $index++) {',
            '    $names += [string]$collection.Item($index).Name',
            '  }',
            '  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $names -Compress))',
            '} catch {',
            '  [Console]::Error.WriteLine($_.Exception.Message)',
            '  exit 1',
            '}',
        ].join('\r\n');
        const result = spawnSync(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', windowsHide: true, timeout: 15000 },
        );
        if (result.error || result.status !== 0) {
            const details = result.error?.message || result.stderr.trim() || 'PowerShell failed to query Access.';
            throw vscode.FileSystemError.Unavailable(
                `Could not read the running Microsoft Access instance: ${details}`,
            );
        }

        try {
            const names: unknown = JSON.parse(result.stdout.trim());
            if (Array.isArray(names) && names.every(name => typeof name === 'string')) {
                return names;
            }
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            throw vscode.FileSystemError.Unavailable(`Could not parse Access object names: ${details}`);
        }
        throw vscode.FileSystemError.Unavailable('PowerShell returned an invalid list of Access object names.');
    }

    private getObjectContent(category: Category, fileName: string): Uint8Array {
        const extension = `.${this.getExtension(category)}`;
        if (!fileName.endsWith(extension)) {
            throw vscode.FileSystemError.FileNotFound(fileName);
        }
        const name = fileName.slice(0, -extension.length);

        switch (category) {
            case 'modules':
                const content = this.getCodeModuleContent(name);
                if (!content) {
                    throw vscode.FileSystemError.FileNotFound(fileName);
                }
                return Buffer.from(`${content}\n`, 'utf8');
        }

        const content = `Name: ${name}\nCategory: ${category}\n\nThis is a placeholder for the content of the Access object.`;
        return Buffer.from(`${content}\n`, 'utf8');
    }

    private getCodeModuleContent(name: string): string | undefined {
        if (process.platform !== 'win32') {
            throw vscode.FileSystemError.Unavailable('Reading Access objects requires Windows.');
        }

        const script = [
            '$ErrorActionPreference = "Stop"',
            'try {',
            '  $access = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Access.Application")',
            '  $vbProject = $access.VBE.ActiveVBProject',
            `  $vbComponent = $vbProject.VBComponents.Item("${name}")`,
            '  $codeModule = $vbComponent.CodeModule',
            '  $lineCount = $codeModule.CountOfLines',
            '  $content = $codeModule.Lines(1, $lineCount)',
            '  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $content -Compress))',
            '} catch {',
            '  [Console]::Error.WriteLine($_.Exception.Message)',
            '  exit 1',
            '}',
        ].join('\r\n');
        const result = spawnSync(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', windowsHide: true, timeout: 15000 },
        );
        if (result.error || result.status !== 0) {
            const details = result.error?.message || result.stderr.trim() || 'PowerShell failed to query Access.';
            throw vscode.FileSystemError.Unavailable(
                `Could not read code module ${name} from the running Microsoft Access instance: ${details}`,
            );
        }

        try {
            const content: unknown = JSON.parse(result.stdout.trim());
            if (typeof content === 'string') {
                return content;
            }
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            throw vscode.FileSystemError.Unavailable(`Could not parse Access object names: ${details}`);
        }
        throw vscode.FileSystemError.Unavailable(`PowerShell returned no content for code module ${name}.`);
    }

    private setCodeModuleContent(category: Category, name: string, content: string): void {
        if (process.platform !== 'win32') {
            throw vscode.FileSystemError.Unavailable('Reading Access objects requires Windows.');
        }

        const extension = `.${this.getExtension(category)}`;
        if (!name.endsWith(extension)) {
            throw vscode.FileSystemError.FileNotFound(name);
        }
        const accessObjectName = name.slice(0, -extension.length);

        const script = [
            '$ErrorActionPreference = "Stop"',
            'try {',
            '  $access = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Access.Application")',
            '  $vbProject = $access.VBE.ActiveVBProject',
            `  $vbComponent = $vbProject.VBComponents.Item("${accessObjectName}")`,
            '  $codeModule = $vbComponent.CodeModule',
            '  $lineCount = $codeModule.CountOfLines',
            '  $codeModule.DeleteLines(1, $lineCount)',
            `  $codeModule.AddFromString(@'
${content}
'@)`,
            '} catch {',
            '  [Console]::Error.WriteLine($_.Exception.Message)',
            '  exit 1',
            '}',
        ].join('\r\n');
        const result = spawnSync(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', windowsHide: true, timeout: 15000 },
        );
        if (result.error || result.status !== 0) {
            const details = result.error?.message || result.stderr.trim() || 'PowerShell failed to query Access.';
            throw vscode.FileSystemError.Unavailable(
                `Could not write code module ${name} from the running Microsoft Access instance: ${details}`,
            );
        }
    }

}
