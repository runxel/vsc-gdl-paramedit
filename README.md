# GDL Parameter Editor

VSCode extension to make visual editing of GDL parameter lists (`paramlist.xml`) possible, similar to the native Archicad GDL parameter editor.
These .xml are available by "decompiling" a .gsm object with the LP_XMLConverter.
Editing happens lossless.


> Forked from [gdl-joe](https://github.com/gdl-joe/vscode-gdl-parameter-editor).


## Install

See [Releases](https://github.com/runxel/vsc-gdl-paramedit/releases/latest).

In VSCode: **"Extensions: Install from VSIX"**.

## Ausprobieren (aus dem Quellcode)

1. Clone the repo and open the folder in VSCode.
2. Press **F5**.
3. Open a `paramlist.xml` file.

Using "Reopen Editor With… → Text Editor" you can show the actual file contents every time.

## Features

- edit all parameter types
- add new parameters in any place
- change parameter types
- delete parameters with a single click
- filter/search
- fixed parameters ("blue") are preserved and protected
- multiline selection
- rearranging via drag & drop
- collapsible groups: a title plus the "child"-flagged parameters below it — dragging a collapsed group moves its whole content
- copy & pasting between different .xml files
- sub-editor for array fields (1D & 2D): edit cells, add/remove rows/columns

## Build
To build a new version use `npx @vscode/vsce package -o dist/gdl-parameter-editor-<ver>.vsix`.
