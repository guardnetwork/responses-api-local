# Third-party notices

The macOS build bundles Node.js and a modified CLIProxyAPI binary. The build copies the applicable licenses and notices to `Contents/Resources/Licenses` in the app bundle.

## CLIProxyAPI

The build fetches [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) at commit `091ff27f31285ec4fd1dd5823b44f7f51fb8f48b` and verifies the source archive checksum. The original MIT license and copyright notice, the local patch license, and source information are in [CLIProxyAPI](CLIProxyAPI/).

## Node.js and Go dependencies

The build copies the license from the verified Node.js distribution. The [Go notice inventory](Go/) contains the Go toolchain license and collected module notices. Those modules retain their respective licenses.

Keep the bundled notices with any redistributed binaries.
