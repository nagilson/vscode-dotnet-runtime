# .NET Runtime and SDK Installation Tools

This repo contains the [vscode-dotnet-runtime](vscode-dotnet-runtime-extension/README.md) extension (the **.NET Install Tool**). It provides VS Code commands and APIs that help extensions find, install, uninstall, and manage .NET for VS Code, including local runtimes and SDKs as well as system-wide SDK acquisition. The former standalone `vscode-dotnet-sdk` extension has been removed and its capabilities folded into this extension.

## Contributing to Repository

Looking for something to work on? The list
of [up-for-grabs issues](https://github.com/dotnet/vscode-dotnet-runtime/labels/up-for-grabs) is a great place to start.

Please read the following documents to get started.

* [Contributing Guide](Documentation/contributing.md)
* [Contributing Workflow](Documentation/contributing-workflow.md)

This project has adopted the code of conduct defined by the [Contributor Covenant](http://contributor-covenant.org/)
to clarify expected behavior in our community. For more information, see the [.NET Foundation Code of Conduct](http://www.dotnetfoundation.org/code-of-conduct).

## Building

### Requirements

- Node.js + npm
- VSCode

### Running the sample

1. Run the build script at the root of the repo (`build.sh` or `build.cmd`).
2. Open the repo's [workspace](vscode-dotnet-runtime.code-workspace) in VSCode
3. Run the `Run Sample Extension` configuration in VSCode
4. In the launched experimental instance open the command pallete and run the `Sample: Run a dynamically acquired .NET Core Hello World App`.

## .NET Foundation

.NET Core for VSCode is a [.NET Foundation](https://www.dotnetfoundation.org/projects) project.

See the [.NET home repo](https://github.com/Microsoft/dotnet) to find other .NET-related projects.

## License

.NET Core (including this repo) is licensed under the MIT license.
