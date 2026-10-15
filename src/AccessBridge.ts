import * as vscode from 'vscode';
import type { Category } from './AccessFileSystemProvider';
import type { Object as WinaxObject } from 'winax';
import * as path from 'path';
import { spawnSync } from 'child_process';

declare global {
    interface ActiveXObjectOptions {
        getaccessibleobject?: boolean;
    }
}

export interface AccessInstance {
    processId: number;
    title: string;
    windowTitles: string[];
    databasePath: string;
    databaseName: string;
}

export class AccessBridge {
    private accessInstance: WinaxObject | undefined;

    private readonly categories = {
        tables: () => this.access.CurrentData.AllTables,
        queries: () => this.access.CurrentData.AllQueries,
        forms: () => this.access.CurrentProject.AllForms,
        reports: () => this.access.CurrentProject.AllReports,
        classes: () => this.access.CurrentProject.AllModules,
        modules: () => this.access.CurrentProject.AllModules,
        macros: () => this.access.CurrentProject.AllMacros,
    } as const;

    private readonly codeTypes = {
        vbext_ct_StdModule: 1,
        vbext_ct_ClassModule: 2,
        vbext_ct_MSForm: 3,
        vbext_ct_Document: 100,
    };

    private readonly acObjectType = {
        acDatabaseProperties: 11,
        acDefault: -1,
        acDiagram: 8,
        acForm: 2,
        acFunction: 10,
        acMacro: 4,
        acModule: 5,
        acQuery: 1,
        acReport: 3,
        acServerView: 7,
        acStoredProcedure: 9,
        acTable: 0,
        acTableDataMacro: 12,
    };

    constructor() {
        if (process.platform !== 'win32') {
            throw vscode.FileSystemError.Unavailable('Reading Access objects requires Windows.');
        }
    }

    public static getAvailableInstances(): AccessInstance[] {
        const script = [
            "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
            "Add-Type -TypeDefinition @'",
            'using System;',
            'using System.Collections.Generic;',
            'using System.Runtime.InteropServices;',
            'using System.Text;',
            'public static class AccessFsWindows {',
            '    private delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr lParam);',
            '    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr lParam);',
            '    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);',
            '    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);',
            '    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);',
            '    public static string[] GetWindowTitles(int targetProcessId) {',
            '        var titles = new List<string>();',
            '        EnumWindows((hwnd, _) => {',
            '            uint processId;',
            '            GetWindowThreadProcessId(hwnd, out processId);',
            '            if (processId == targetProcessId && IsWindowVisible(hwnd)) {',
            '                var text = new StringBuilder(1024);',
            '                if (GetWindowText(hwnd, text, text.Capacity) > 0) titles.Add(text.ToString());',
            '            }',
            '            return true;',
            '        }, IntPtr.Zero);',
            '        return titles.ToArray();',
            '    }',
            '}',
            "'@",
            "$instances = @(Get-Process -Name MSACCESS -ErrorAction SilentlyContinue | ForEach-Object {",
            "    $processId = $_.Id",
            "    [AccessFsWindows]::GetWindowTitles($processId) | ForEach-Object {",
            "        [PSCustomObject]@{ processId = $processId; title = $_.Trim() }",
            "    }",
            "})",
            "ConvertTo-Json -InputObject $instances -Compress",
        ].join('\n');
        const result = spawnSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script,
        ], { encoding: 'utf8', windowsHide: true });

        if (result.error) {
            throw new Error(`Could not find running Access instances: ${result.error.message}`);
        }
        if (result.status !== 0) {
            const detail = result.stderr.trim();
            throw new Error(`Could not find running Access instances${detail ? `: ${detail}` : '.'}`);
        }

        const output = result.stdout.trim();
        if (!output || output === 'null') {
            return [];
        }

        const instances: unknown = JSON.parse(output);
        const instanceList = Array.isArray(instances) ? instances : [instances];
        const instancesWithTitles = instanceList.map((instance) => {
            if (
                typeof instance !== 'object'
                || instance === null
                || !('processId' in instance)
                || typeof instance.processId !== 'number'
                || !('title' in instance)
                || typeof instance.title !== 'string'
                || !instance.title
            ) {
                throw new Error('Could not find running Access instances: PowerShell returned invalid instance data.');
            }
            return { processId: instance.processId, title: instance.title };
        });

        const WinaxObject = (require('winax') as typeof import('winax')).Object;
        const instancesWithDatabase = new Map<number, AccessInstance>();
        for (const instance of instancesWithTitles) {
            if (instancesWithDatabase.has(instance.processId)) {
                continue;
            }

            try {
                const accessInstance = new WinaxObject(instance.title, { getaccessibleobject: true });
                const databasePath = accessInstance.CurrentProject.FullName;
                if (typeof databasePath !== 'string' || !databasePath.trim()) {
                    continue;
                }
                instancesWithDatabase.set(instance.processId, {
                    processId: instance.processId,
                    title: instance.title,
                    windowTitles: instancesWithTitles
                        .filter(candidate => candidate.processId === instance.processId)
                        .map(candidate => candidate.title),
                    databasePath,
                    databaseName: path.win32.basename(databasePath),
                });
            } catch (error) {
                console.warn(
                    `Could not inspect Access window "${instance.title}" in process ${instance.processId}.`,
                    error,
                );
            }
        }
        return [...instancesWithDatabase.values()];
    }

    public connectTo(instance: AccessInstance): void {
        const WinaxObject = (require('winax') as typeof import('winax')).Object;
        const expectedPath = path.win32.normalize(instance.databasePath).toLowerCase();
        let lastError: unknown;
        for (const title of instance.windowTitles) {
            try {
                const accessInstance = new WinaxObject(title, { getaccessibleobject: true });
                const databasePath = accessInstance.CurrentProject.FullName;
                if (
                    typeof databasePath === 'string'
                    && path.win32.normalize(databasePath).toLowerCase() === expectedPath
                ) {
                    this.accessInstance = accessInstance;
                    return;
                }
            } catch (error) {
                lastError = error;
            }
        }
        const reason = lastError instanceof Error ? `: ${lastError.message}` : '.';
        throw new Error(`Could not reconnect to the selected Access database "${instance.databaseName}"${reason}`);
    }

    private get access(): WinaxObject {
        if (!this.accessInstance) {
            const WinaxObject = (require('winax') as typeof import('winax')).Object;
            this.accessInstance = new WinaxObject('Access.Application', { activate: true });
        }
        return this.accessInstance;
    }

    public read(category: Category, name: string): string | undefined {
        switch (category) {
            case 'modules':
            case 'classes':
                return this.readCodeModule(name);
        }
        throw vscode.FileSystemError.Unavailable(
            `Access Object category ${category} not supported yet`,
        );
    }

    public write(category: Category, name: string, content: string) {
        switch (category) {
            case 'modules':
            case 'classes':
                return this.writeCodeModule(name, content);
        }
        throw vscode.FileSystemError.Unavailable(
            `Access Object category ${category} not supported yet`,
        );
    }

    public getNames(category: Category): string[] {
        const collection = this.categories[category]();
        const names: string[] = [];
        for (let i = 0; i < collection.Count; i++) {
            const name = collection.Item(i).Name;
            switch (category) {
                case 'modules':
                case 'classes':
                    const { codeModule } = this.getCodeModule(name);
                    if ((codeModule.Parent.Type === this.codeTypes.vbext_ct_StdModule && category === 'modules') ||
                        (codeModule.Parent.Type === this.codeTypes.vbext_ct_ClassModule && category === 'classes')) {
                        names.push(name);
                    }
                    break;
                default:
                    names.push(name);
            }
        }
        return names;
    }

    public rename(category: Category, oldName: string, newName: string) {
        switch (category) {
            case 'modules':
                return this.renameCodeModule(oldName, newName);
        }
        throw vscode.FileSystemError.Unavailable(
            `Access Object category ${category} not supported yet`,
        );
    }

    public delete(category: Category, name: string) {
        switch (category) {
            case 'modules':
                return this.deleteCodeModule(name);
        }
        throw vscode.FileSystemError.Unavailable(
            `Access Object category ${category} not supported yet`,
        );
    }

    private getCodeModule(name: string) {
        const vbProject = this.access.VBE.ActiveVBProject;
        const vbComponent = vbProject.VBComponents.Item(name);
        const codeModule = vbComponent.CodeModule;
        const lineCount = codeModule.CountOfLines;
        return { lineCount, codeModule };
    }

    private readCodeModule(name: string): string | undefined {
        const { lineCount, codeModule } = this.getCodeModule(name);
        return lineCount > 0 ? codeModule.Lines(1, lineCount) : '';
    }

    private writeCodeModule(name: string, content: string) {
        const components = this.access.VBE.ActiveVBProject.VBComponents;
        let existingModule = false;
        for (let i = 1; i <= components.Count; i++) {
            if (components.Item(i).Name.toLowerCase() === name.toLowerCase()) {
                existingModule = true;
                break;
            }
        }

        if (existingModule) {
            const { lineCount, codeModule } = this.getCodeModule(name);
            if (lineCount > 0) {
                codeModule.DeleteLines(1, lineCount);
            }
            codeModule.AddFromString(content);
            return;
        }

        const newModule = components.Add(this.codeTypes.vbext_ct_StdModule);
        newModule.Name = name;
        const lineCount = newModule.CodeModule.CountOfLines;
        if (lineCount > 0) {
            newModule.CodeModule.DeleteLines(1, lineCount);
        }
        newModule.CodeModule.AddFromString(content);
        this.access.DoCmd.Save(this.acObjectType.acModule, name);
    }

    private renameCodeModule(oldName: string, newName: string) {
        const { codeModule } = this.getCodeModule(oldName);
        codeModule.Parent.Name = newName;
    }

    private deleteCodeModule(name: string) {
        const { codeModule } = this.getCodeModule(name);
        const vbComponent = codeModule.Parent;
        this.access.VBE.ActiveVBProject.VBComponents.Remove(vbComponent);
    }
}