# LightMD

Local Markdown/HTML reader. Desktop shell is [Tauri 2](https://v2.tauri.app/) with WebKitGTK on Linux. Not Electron.

**Atrium** is the documented v1 Linux build host. A Mac is not required for v1.

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
