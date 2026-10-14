# Access FileSystem Provider

This is a proof-of-concept for a VS Code Extension that provides a file system backed by an Access Database.

## How to use

Prerequisites: To build this extension you need to have VC++ libraries and Python3 installed. You also need a recent VS Code installation and at least one open Microsoft Access database on the same machine.

Clone this git repo. Open the git repo in VS Code and press `F5` to start debugging.

Press `F1` and execute command `AccessFS: Add access objects to workspace`. Select the open database by filename from the list. Access windows without an open database are omitted. You should now be able to browse the selected `.accdb` in the VS Code browser.

> Currently, only code modules can be read and written with this extension.

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
- Almost complete support for code modules in `.accdb` (copy is still broken)

## Architecture

This extension implements a `vscode.FileSystemProvider`. It currently implements an access bridge using `winax` to retrieve access objects.