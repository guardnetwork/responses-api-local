# CLIProxyAPI source and license notices

The macOS build compiles a modified CLIProxyAPI binary from the following source.

- [Upstream source](https://github.com/router-for-me/CLIProxyAPI)
- Pinned commit `091ff27f31285ec4fd1dd5823b44f7f51fb8f48b`
- Source archive SHA-256 `83795a296dbcb3ea5c69e7dadb1ef08a0284ccff1add89c999e90298dba9e8d6`
- [Original MIT license and copyright notice](LICENSE.CLIProxyAPI)
- [Local patch license](LICENSE.responses-proxy)

The local patch restricts routes and validates the selected model and reasoning effort on outbound requests. In the source checkout, `Proxy/` contains the build script, patch files, and policy tests. The app bundle records the pinned source and catalog inputs in `Contents/Resources/Gateway/proxy-build.json`.

Go and third-party Go modules retain their respective licenses. The pinned upstream `go.mod` and `go.sum` record module versions and checksums. See the accompanying Go notice inventory for those licenses.
