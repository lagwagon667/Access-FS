# Access FileSystem Provider

This is a proof-of-concept for a VS Code Extension that provides a file system backed by an Access Database.

## How to use

Prerequisites: To build this extension you need to have VC++ libraries and Python3 installed. You also need a recent VS Code installation and at least one open Microsoft Access database on the same machine.

Clone this git repo. Open the git repo in VS Code and press `F5` to start debugging.

Press `F1` and execute command `AccessFS: Add access objects to workspace`. Select the open database by filename from the list. Access windows without an open database are omitted. You should now be able to browse the selected `.accdb` in the VS Code browser.

Use `AccessFS: Search Access Objects` from the Command Palette to search object names and module source. VS Code's built-in Search view does not search this custom Access filesystem.

Table files use `.sql` scripts containing a `CREATE TABLE` statement, optional `CREATE INDEX` / `CREATE UNIQUE INDEX` statements, and `INSERT` statements for their rows. Index statements support primary keys using `WITH PRIMARY`, composite keys, and ascending or descending index fields. To create a table, create a `.sql` file under `tables` and save a script whose table name matches the filename (without `.sql`). Copying a table file to a new filename creates a new table with that name; the Access Navigation Pane is refreshed after creation. Renaming an existing table file renames the Access table and its generated `CREATE TABLE` statement. Deleting a table `.sql` file deletes the Access table; an open table is closed without saving first. Saving a different schema or index definition rebuilds the table from the script: existing table data is discarded and replaced by the listed rows, and AutoNumber values may change. The extension closes the table in Access before dropping it. Relationships and other table metadata not represented in the script are not preserved; Access may reject a rebuild when relationships prevent dropping the table.

Table SQL files under a `tables` folder are validated as you edit them. Errors such as a missing leading `CREATE TABLE`, a table name that differs from the filename, or `INSERT` statements that omit required fields appear as editor diagnostics. Inserts that omit nullable columns also receive a warning listing the fields not explicitly specified.

When the schema and indexes are unchanged, rows are matched to existing records by their current order; trailing rows omitted from the file are deleted and additional rows are appended. AutoNumber values for existing rows must not be changed or reordered. For new rows, numeric AutoNumber values in `INSERT` statements are ignored; Access generates the actual ID, and the open SQL document is refreshed with the generated value after saving. Binary and complex Access field types, inline table constraints, and relationships are not represented by the SQL format.

Code modules can also be read and written with this extension.

Access-FS includes an adapted copy of the MIT-licensed [VBA Language Server](https://github.com/SSlinky/VBA-LanguageServer/tree/v1.7.4) (v1.7.4) for `.bas` and `.cls` documents opened from its virtual filesystem. It parses open virtual documents directly and does not try to scan an `accessfs:` workspace as a disk folder. IntelliSense suggests declarations from the current module and public project scope, along with common VBA keywords, types, and VBA/Access built-ins. Access-FS does not yet provide completion for external COM/type-library members. The separate `NotisDataAnalytics.vba-lsp` extension is incompatible with Access-FS workspaces: its language server attempts to scan `accessfs:/` as a disk path and crashes. Disable that extension for the Access-FS workspace or uninstall it. Access-FS launches its own adapted language server; the upstream extension is no longer recommended.

Hidden and system Access objects are shown with a dimmed name in the VS Code Explorer.

To use the custom table icon, open the Command Palette, choose `Preferences: File Icon Theme`, and select `Access-FS Table Icons`. VS Code file icon themes match by extension rather than folder path, so the `.sql` icon is used for SQL files throughout VS Code. This theme uses simple generic icons for other files and folders; select your previous icon theme to restore the previous icons.

### Troubleshooting

#### I do not get any access objects shown in my browser

Check the task manager for a zombie Access process with an open database. Close it and run the command again to select your designated database.

#### I get an error stating that winax was built against a different node version

Find out the electron version of VS code (Help / About) and run

```bash
npx electron-rebuild -f -w winax -v <electron_version>
```

## Current State

This extension currently is in a very early stage and only has a limited feature set.

- Browse all objects available in the current `.accdb`
- Read and write rows and supported schemas in Access tables; create tables from `.sql` files
- Read and write code modules in `.accdb`

## Architecture

This extension implements a `vscode.FileSystemProvider`. It currently implements an access bridge using `winax` to retrieve access objects.