# Changelog

All notable changes to LightMD are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Open a folder or file from the command line: `lightmd .`, `lightmd notes/`, `lightmd README.md`.
- Live reload: an open file that another program changes updates on screen, unless it has unsaved edits.
- Recent folders menu next to Open Folder, also shown in the explorer when no folder is open.
- Outline of the document's headings; clicking one moves the editor and preview there.
- Scroll sync between editor and preview, with a Settings toggle.
- Heading anchors and relative `.md` / `.html` links work in the preview.
- A dirty marker on tabs with unsaved changes.
- A new app icon, also shown inside the app: a welcome screen when nothing is open, the explorer header, Settings → About (with a Changelog link) and an empty preview.

### Changed

- The window opens maximized. Remember pane layout keeps pane widths and visibility, not the window size.
- Settings are saved and restored between launches.
- The preview updates after a short pause while you type instead of on every keystroke.
- Workspace search is much faster on large folders and includes unsaved edits.
- Keyboard shortcuts use Cmd on macOS and Ctrl on Linux, and follow the typed key on non-QWERTY layouts.
- JavaScript in HTML files is turned on per file and is never saved.

### Fixed

- Undo could put another file's text into the current file, which autosave then wrote to disk.
- After Save As into another folder, other tabs autosaved into that folder.
- Closing, switching or replacing tabs could discard unsaved edits without asking.
- Closing a tab could put its text into the untitled draft.
- Saving rewrote CRLF line endings as LF.
- Changes made to a file by another program could be silently overwritten.
- A crash or full disk during a save could leave the file empty; saves now replace the file in one step.
- Dragging a splitter stopped after the first move and snapped the pane to its minimum width.
- Opening a file reset scroll positions and could steal focus from the editor.
- Pane widths were saved wrongly, could push the preview off-screen, and the explorer kept growing.
- Hiding the explorer hid every toolbar control.
- The editor font size and Default folder settings had no effect.
- Images with spaces or non-ASCII characters in their names didn't load.
- Cmd/Ctrl+S on a new note did nothing; save errors weren't shown.

### Security

- HTML files can no longer load remote images, stylesheets, fonts or frames.
- The backend rejects symlinks that lead outside the opened folder.
- The app's permissions are reduced to what it uses, and the window can't be navigated away from the app.
