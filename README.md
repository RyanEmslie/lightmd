# LightMD

Local Markdown/HTML reader. Desktop shell is [Tauri 2](https://v2.tauri.app/) with WebKitGTK on Linux. Not Electron.

**Atrium** is the documented v1 Linux build host. A Mac is not required for v1.

v1 ships by clone-and-build from this README on Linux and Mac. There are no GitHub Releases and no installers.

## Prerequisites (Linux)

- Node.js 20+ and npm
- Rust **stable via [rustup](https://rustup.rs/)** — Debian’s `rustc` is too old for Tauri 2; do not use the distro package
- WebKitGTK 4.1 and GTK 3 development packages

Install rustup stable from [rustup.rs](https://rustup.rs/):

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
rustup default stable
```

Debian / Ubuntu (Atrium is Debian):

```sh
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  pkg-config
```

See [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) for Arch, Fedora, and other distros.

## Install and run

```sh
npm install
npm run tauri dev
```

`npm test` is optional. `tauri dev` opens a native window titled **LightMD**.

## Build

```sh
npm run tauri build
```

`tauri build` produces a Linux bundle under `src-tauri/target/release/bundle/` without a Mac.

## Clone and build on macOS

This Mac path is optional clone-and-build for a desktop machine. A Mac is not required for v1 (Atrium remains the daily TDD host). It is not a v1 Linux prerequisite.

```sh
git clone https://github.com/clearly-bots/lightmd
cd lightmd
```

### Prerequisites (macOS)

For Mac desktop Tauri only:

- **Xcode Command Line Tools** — run `xcode-select --install`. The full Xcode app is not required. Apple Developer Program is not required. Signing and notarization are later (#32), not a v1 Mac clone-and-build step.
- Rust **stable via [rustup](https://rustup.rs/)** (`rustup default stable`)
- Node.js 20+ and npm

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
rustup default stable
```

### Install, run, and build

```sh
npm install
npm run tauri dev
npm run tauri build
```

`tauri dev` and `tauri build` open a **LightMD** window that can Open Folder of local `.md` / `.html` files. macOS uses WKWebView; Linux uses WebKitGTK.

## Open from the command line

Pass a folder or a file to open it instead of the last session:

```sh
lightmd .            # this folder
lightmd notes/       # another folder
lightmd README.md    # the file's folder, with the file open
```

`tauri build` doesn't put `lightmd` on your `PATH`. Link the built binary once:

```sh
# Linux
ln -s "$PWD/src-tauri/target/release/lightmd" ~/.local/bin/lightmd
# macOS
ln -s "$PWD/src-tauri/target/release/bundle/macos/LightMD.app/Contents/MacOS/lightmd" /usr/local/bin/lightmd
```

Each run opens a new window.

## Privacy / local-only

v1 has no telemetry. File access is the opened workspace folder (and any file you Save As elsewhere) plus app config (theme, session, and layout). The backend keeps file paths inside the folder the app passes it; it relies on the app's own code to pass only folders you chose. Theme, session, and layout stay on this machine (OS/localStorage). https links open via the system browser (`tauri-plugin-opener` / `openUrl`) only when the user clicks.

The Markdown preview does not load remote images. HTML files open in a sandboxed frame whose Content-Security-Policy blocks remote images, stylesheets, fonts, media, frames, and form posts. JavaScript in HTML files is off by default; turning it on applies to the open file until you switch files or restart, is never saved, and its scripts still cannot fetch or load anything remote. There is no update check in v1.
