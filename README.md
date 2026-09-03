# LightMD

Local Markdown/HTML reader. Desktop shell is [Tauri 2](https://v2.tauri.app/) with WebKitGTK on Linux. Not Electron.

v1 is developed and tested on **Atrium** (Linux). A Mac is not required to run this scaffold.

## Prerequisites (Linux)

- Node.js 20+ and npm
- Rust **stable via [rustup](https://rustup.rs/)** (Debian’s `rustc` 1.85 is too old for Tauri 2)
- WebKitGTK 4.1 and GTK 3 development packages

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
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

See [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) for Arch, Fedora, and others.

## Run

```sh
npm install
npm test
npm run tauri dev
```

`tauri dev` opens a native window titled **LightMD**.

## Build

```sh
npm run tauri build
```

That produces a Linux bundle under `src-tauri/target/release/bundle/` without a Mac.
