# Contributing

Thanks for helping improve Run My Agents. This guide covers the local setup, test commands, and macOS app build.

## Prerequisites

- [Bun](https://bun.sh/) 1.4.3 or newer
- Node.js 22 for the hooks test suite
- macOS 13 or newer and Xcode Command Line Tools to build the native Mac app

The Mac app build uses Apple's Swift compiler and command-line utilities, including `swiftc`, `sips`, `iconutil`, and `codesign`.

## Set up the repository

From the repository root, install the workspace dependencies:

```sh
bun install
```

## Run the tests

Run the Bun test suites from the repository root:

```sh
bun test
```

Run the hooks suite, including its Node.js unit tests and shell-based integration checks:

```sh
bash test/test.sh
```

For the full project check used by CI, run:

```sh
bun run check
```

This checks the web app, board, Kitchen agent, eval grader, and hooks. The script installs each workspace's dependencies before running its type checks, lint where configured, and tests. The hooks suite requires Node.js 22.

When changing the hooks, run `bash test/test.sh` before submitting the change. When changing a workspace, also run its relevant checks from that workspace directory.

## Build the macOS app

The native app is built on macOS. From the repository root:

```sh
cd mac
./build.sh
open "build/Run My Agents.app"
```

This creates a development app in `mac/build/`. It uses the board checkout at `services/app/board`; install the repository dependencies first with `bun install`. If the board is not already running, the app starts it with Bun.

To build the universal release app and its ZIP archive instead:

```sh
./build.sh --release
```

The release build compiles for Apple Silicon and Intel and bundles the board, so Bun is not needed to run the resulting app. Signing and notarization depend on the available Apple developer credentials; see [mac/README.md](mac/README.md) and [docs/MAC_NOTARIZATION.md](docs/MAC_NOTARIZATION.md) for details.

## Before opening a change

- Keep changes focused and include tests for changed behavior.
- Run the checks relevant to the files you changed.
- Include a concise description of the behavior changed and the commands used to verify it.
