import * as vscode from 'vscode';
import { Category } from './AccessFileSystemProvider';
import { Object as WinaxObject } from 'winax';

export class AccessBridge {
    private readonly access: WinaxObject = new WinaxObject('Access.Application', { activate: true });

    private readonly categories = {
        tables: this.access.CurrentData.AllTables,
        queries: this.access.CurrentData.AllQueries,
        forms: this.access.CurrentProject.AllForms,
        reports: this.access.CurrentProject.AllReports,
        modules: this.access.CurrentProject.AllModules,
        macros: this.access.CurrentProject.AllMacros,
    } as const;

    constructor() {
        if (process.platform !== 'win32') {
            throw vscode.FileSystemError.Unavailable('Reading Access objects requires Windows.');
        }
    }

    public read(category: Category, name: string): string | undefined {
        switch (category) {
            case 'modules':
                return this.readCodeModule(name);
        }
        throw vscode.FileSystemError.Unavailable(
            `Access Object category ${category} not supported yet`,
        );
    }

    public write(category: Category, name: string, content: string) {
        switch (category) {
            case 'modules':
                return this.writeCodeModule(name, content);
        }
        throw vscode.FileSystemError.Unavailable(
            `Access Object category ${category} not supported yet`,
        );
    }

    public getNames(category: Category): string[] {
        const collection = this.categories[category];
        const names: string[] = [];
        for (let i = 0; i < collection.Count; i++) {
            names.push(collection.Item(i).Name);
        }
        return names;
    }

    private getCodeModule(name: string) {
        const vbProject = this.access.VBE.ActiveVBProject;
        const vbComponent = vbProject.VBComponents.Item(name);
        const codeModule = vbComponent.CodeModule;
        codeModule.CodePane.Show();
        const lineCount = codeModule.CountOfLines;
        return { lineCount, codeModule };
    }

    private readCodeModule(name: string): string | undefined {
        const { lineCount, codeModule } = this.getCodeModule(name);
        const content = codeModule.Lines(1, lineCount);
        return content;
    }

    private writeCodeModule(name: string, content: string) {
        const { lineCount, codeModule } = this.getCodeModule(name);
        codeModule.DeleteLines(1, lineCount);
        codeModule.AddFromString(content);
    }
}