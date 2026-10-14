import * as vscode from 'vscode';
import { Category } from './AccessFileSystemProvider';
import { Object as WinaxObject } from 'winax';

export class AccessBridge {
    private readonly access: WinaxObject = new WinaxObject('Access.Application', { activate: true });

    private readonly categories = {
        tables: () => this.access.CurrentData.AllTables,
        queries: () => this.access.CurrentData.AllQueries,
        forms: () => this.access.CurrentProject.AllForms,
        reports: () => this.access.CurrentProject.AllReports,
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
    }

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
        const collection = this.categories[category]();
        const names: string[] = [];
        for (let i = 0; i < collection.Count; i++) {
            names.push(collection.Item(i).Name);
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
        try {
            const { lineCount, codeModule } = this.getCodeModule(name);
            codeModule.DeleteLines(1, lineCount);
            codeModule.AddFromString(content);
        } catch (error) {
            // new code module
            const newModule = this.access.VBE.ActiveVBProject.VBComponents.Add(this.codeTypes.vbext_ct_StdModule);
            newModule.Name = name;
            this.access.DoCmd.Save(this.acObjectType.acModule, name);
        }
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