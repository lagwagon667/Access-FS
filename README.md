# Access FileSystem Provider

This is a proof-of-concept for a VS Code Extension that provides a file system backed by an Access Database.

## How to use

Prerequisites: To build this extension you need to have VC++ libraries and Python3 installed. You also need a recent VS Code installation and Microsoft Access running on the same machine.

Clone this git repo. Make sure you have only one Access instance running with an `.accdb` opened. Open the git repo in VS code and press `F5` to start debugging.

Press `F1` and execute command `AccessFS: Add access objects to workspace`. You should now be able to browse your `.accdb` in the VS Code browser.

> Currently, only code modules can be read and written with this extension.

### Troubleshooting

#### I do not get any access objects shown in my browser

Check the task manager, if there is still a zombie-access process around. Chances are the extension connects to this access instance instead of your designated access window.

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