/*---------------------------------------------------------------------------------------------
*  Licensed to the .NET Foundation under one or more agreements.
*  The .NET Foundation licenses this file to you under the MIT license.
*--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
// import * as runtimeExtension from 'vscode-dotnet-runtime'; // comment this out when packing the extension
import
{
    DotnetInstallMode,
    DotnetVersionSpecRequirement,
    IDotnetAcquireContext,
    IDotnetAcquireResult,
    IDotnetFindPathContext,
    IDotnetLogResult
} from 'vscode-dotnet-runtime-library';

export function activate(context: vscode.ExtensionContext)
{

    // --------------------------------------------------------------------------

    /*

    NOTE: This sample should technically have the following in its package.json:

    "extensionDependencies": [
        "ms-dotnettools.vscode-dotnet-runtime",
    ]

    This would enable the sample to require the vscode-dotnet-runtime extension
    */

    const requestingExtensionId = 'ms-dotnettools.sample-extension';
    // runtimeExtension.activate(context); // comment this out when packing the extension


    // --------------------------------------------------------------------------

    // -------------------runtime extension registrations------------------------

    const sampleHelloWorldRegistration = vscode.commands.registerCommand('sample.helloworld', async () =>
    {
        try
        {
            await vscode.commands.executeCommand('dotnet.showAcquisitionLog');

            // Console app requires .NET Core 2.2.0
            const commandRes = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', { version: '2.2', requestingExtensionId });
            const dotnetPath = commandRes!.dotnetPath;
            if (!dotnetPath)
            {
                throw new Error('Could not resolve the dotnet path!');
            }

            const sampleExtension = vscode.extensions.getExtension('ms-dotnettools.sample-extension');
            if (!sampleExtension)
            {
                throw new Error('Could not find sample extension.');
            }
            const helloWorldLocation = path.join(sampleExtension.extensionPath, 'HelloWorldConsoleApp', 'HelloWorldConsoleApp.dll');
            const helloWorldArgs = [helloWorldLocation];

            // This will install any missing Linux dependencies.
            await vscode.commands.executeCommand('dotnet.ensureDotnetDependencies', { command: dotnetPath, arguments: helloWorldArgs });

            const result = cp.spawnSync(dotnetPath, helloWorldArgs);
            const stderr = result?.stderr?.toString();
            if ((stderr?.length ?? 0) > 0)
            {
                vscode.window.showErrorMessage(`Failed to run Hello World:
${stderr}`);
                return;
            }

            const appOutput = result?.stdout?.toString();
            vscode.window.showInformationMessage(`.NET Output: ${appOutput}`);
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    async function callAcquireAPI(version: string | undefined, installMode: DotnetInstallMode | undefined, forceUpdates = true)
    {
        if (!version)
        {
            version = await vscode.window.showInputBox({
                placeHolder: '3.1',
                value: '3.1',
                prompt: '.NET version, i.e. 3.1',
            });
        }

        try
        {
            await vscode.commands.executeCommand('dotnet.showAcquisitionLog');
            await vscode.commands.executeCommand('dotnet.acquire', { version, requestingExtensionId, mode: installMode, forceUpdate: forceUpdates });
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    }

    const sampleAcquireRegistration = vscode.commands.registerCommand('sample.dotnet.acquire', async (version: string | undefined) =>
    {
        await callAcquireAPI(version, undefined);
    });

    const sampleAcquireASPNETRegistration = vscode.commands.registerCommand('sample.dotnet.acquireASPNET', async (version: string | undefined) =>
    {
        await callAcquireAPI(version, 'aspnetcore');
    });

    const sampleAcquireNoForceRegistration = vscode.commands.registerCommand('sample.dotnet.acquireNoForce', async (version: string | undefined) =>
    {
        const mode = await vscode.window.showInputBox({
            placeHolder: 'runtime',
            value: 'runtime',
            prompt: '.NET mode to acquire, e.g. runtime or aspnetcore',
        });

        await callAcquireAPI(undefined, mode as DotnetInstallMode, false);
    });

    const sampleAcquireStatusRegistration = vscode.commands.registerCommand('sample.dotnet.acquireStatus', async (version: string | undefined) =>
    {
        if (!version)
        {
            version = await vscode.window.showInputBox({
                placeHolder: '3.1',
                value: '3.1',
                prompt: '.NET version, i.e. 3.1',
            });
        }

        try
        {
            await vscode.commands.executeCommand('dotnet.showAcquisitionLog');
            const status = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquireStatus', { version, requestingExtensionId });
            vscode.window.showInformationMessage(status === undefined ? '.NET is not installed' : `.NET version ${version} installed at ${status.dotnetPath}`);
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    const sampleDotnetUninstallAllRegistration = vscode.commands.registerCommand('sample.dotnet.uninstallAll', async () =>
    {
        try
        {
            await vscode.commands.executeCommand('dotnet.uninstallAll');
            vscode.window.showInformationMessage('.NET runtimes uninstalled.');
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    const sampleAcquireSDKRegistration = vscode.commands.registerCommand('sample.dotnet.acquireSDK', async (version: string | undefined) =>
    {
        await callAcquireAPI(version, 'sdk');
    });

    const sampleAcquireSDKStatusRegistration = vscode.commands.registerCommand('sample.dotnet.acquireSDKStatus', async (version: string | undefined) =>
    {
        if (!version)
        {
            version = await vscode.window.showInputBox({
                placeHolder: '8.0',
                value: '8.0',
                prompt: '.NET SDK version, i.e. 8.0',
            });
        }

        try
        {
            await vscode.commands.executeCommand('dotnet.showAcquisitionLog');
            const status = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquireStatus', { version, requestingExtensionId, mode: 'sdk' });
            vscode.window.showInformationMessage(status === undefined ? '.NET SDK is not installed' : `.NET SDK version ${version} installed at ${status.dotnetPath}`);
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    const sampleUninstallSDKRegistration = vscode.commands.registerCommand('sample.dotnet.uninstallSDK', async (version: string | undefined) =>
    {
        if (!version)
        {
            version = await vscode.window.showInputBox({
                placeHolder: '8.0',
                value: '8.0',
                prompt: '.NET SDK version to uninstall, i.e. 8.0',
            });
        }

        try
        {
            await vscode.commands.executeCommand('dotnet.uninstall', { version, requestingExtensionId, mode: 'sdk', installType: 'local' });
            vscode.window.showInformationMessage(`.NET SDK ${version} uninstalled.`);
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    const sampleUninstallAllSDKRegistration = vscode.commands.registerCommand('sample.dotnet.uninstallAllSDK', async () =>
    {
        try
        {
            // uninstallAll is mode-agnostic: it removes every VS Code-managed install, runtimes and SDKs alike.
            await vscode.commands.executeCommand('dotnet.uninstallAll');
            vscode.window.showInformationMessage('.NET runtimes and SDKs uninstalled.');
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    const sampleResetUpdateSuccessTime = vscode.commands.registerCommand('sample.dotnet.resetUpdateTimer', async () =>
    {
        try
        {
            const resetResult = await vscode.commands.executeCommand<Date | undefined>('dotnet._resetUpdateTimer');
            const resetDisplay = resetResult ? new Date(resetResult).toString() : 'undefined';
            vscode.window.showInformationMessage(`.NET update timer reset to: ${resetDisplay}`);
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    async function acquireConcurrent(versions: [string, string, string], installMode?: DotnetInstallMode)
    {
        try
        {
            vscode.commands.executeCommand('dotnet.showAcquisitionLog');
            const promises = [
                vscode.commands.executeCommand('dotnet.acquire', { version: versions[0], requestingExtensionId, mode: installMode }),
                vscode.commands.executeCommand('dotnet.acquire', { version: versions[1], requestingExtensionId, mode: installMode }),
                vscode.commands.executeCommand('dotnet.acquire', { version: versions[2], requestingExtensionId, mode: installMode })];

            for (const promise of promises)
            {
                // Await here so we can detect errors
                await promise;
            }
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    }

    const sampleConcurrentTest = vscode.commands.registerCommand('sample.dotnet.concurrentTest', async () =>
    {
        await acquireConcurrent(['8.0', '9.0', '10.0'], 'runtime');
    });

    const sampleConcurrentASPNETTest = vscode.commands.registerCommand('sample.dotnet.concurrentASPNETTest', async () =>
    {
        acquireConcurrent(['8.0', '9.0', '10.0'], 'runtime') // start this so we test concurrent types of runtime installs
        await acquireConcurrent(['8.0', '9.0', '10.0'], 'aspnetcore');
    });

    const sampleShowAcquisitionLogRegistration = vscode.commands.registerCommand('sample.dotnet.showAcquisitionLog', async () =>
    {
        try
        {
            await vscode.commands.executeCommand('dotnet.showAcquisitionLog');
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    const sampleGetAcquisitionLogRegistration = vscode.commands.registerCommand('sample.dotnet.getAcquisitionLog', async () =>
    {
        try
        {
            const result = await vscode.commands.executeCommand<IDotnetLogResult>('dotnet.getAcquisitionLog');
            vscode.window.showInformationMessage(`.NET acquisition log path: ${result?.logPath ?? 'undefined'}`);
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    const sampleGlobalSDKFromRuntimeRegistration = vscode.commands.registerCommand('sample.dotnet.acquireGlobalSDK', async (version: string | undefined) =>
    {
        if (!version)
        {
            version = await vscode.window.showInputBox({
                placeHolder: '7.0.103',
                value: '7.0.103',
                prompt: 'The .NET SDK version. You can use different formats: 5, 3.1, 7.0.3xx, 6.0.201, etc.',
            });
        }

        if (!version)
        {
            return;
        }

        try
        {
            await vscode.commands.executeCommand('dotnet.showAcquisitionLog');
            let commandContext: IDotnetAcquireContext = { version: version, requestingExtensionId: requestingExtensionId, installType: 'global' };
            await vscode.commands.executeCommand('dotnet.acquireGlobalSDK', commandContext);
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    const sampleFindPathRegistration = vscode.commands.registerCommand('sample.dotnet.findPath', async () =>
    {
        const version = await vscode.window.showInputBox(
            {
                placeHolder: '8.0',
                value: '8.0',
                prompt: 'The .NET runtime version.',
            });

        let arch = await vscode.window.showInputBox({
            placeHolder: 'x64',
            value: 'x64',
            prompt: 'The .NET runtime architecture.',
        });

        arch = arch?.toLowerCase();

        let searchMode = await vscode.window.showInputBox({
            placeHolder: 'runtime',
            value: 'runtime',
            prompt: 'look for an sdk, runtime, aspnetcore runtime, etc',
        });

        searchMode = searchMode?.toLowerCase() ?? 'runtime';

        let requirement = await vscode.window.showInputBox({
            placeHolder: 'greater_than_or_equal',
            value: 'greater_than_or_equal',
            prompt: 'The condition to search for a requirement.',
        });

        requirement = requirement?.toLowerCase();

        let commandContext: IDotnetFindPathContext = {
            acquireContext: { version: version, requestingExtensionId: requestingExtensionId, architecture: arch, mode: searchMode } as IDotnetAcquireContext,
            versionSpecRequirement: requirement as DotnetVersionSpecRequirement
        };

        const result = await vscode.commands.executeCommand('dotnet.findPath', commandContext);

        vscode.window.showInformationMessage(`.NET Path Discovered\n
${JSON.stringify(result) ?? 'undefined'}`);
    });

    const sampleAvailableInstallsRegistration = vscode.commands.registerCommand('sample.dotnet.availableInstalls', async (version: string | undefined) =>
    {
        let dotnetPath = await vscode.window.showInputBox({
            placeHolder: 'undefined',
            value: 'undefined',
            prompt: 'The .NET Host Path to Scan.',
        });

        dotnetPath = dotnetPath === 'undefined' ? undefined : dotnetPath;

        let arch = await vscode.window.showInputBox({
            placeHolder: 'x64',
            value: 'x64',
            prompt: 'The .NET runtime architecture.',
        });

        arch = arch?.toLowerCase();

        let searchMode = await vscode.window.showInputBox({
            placeHolder: 'runtime',
            value: 'runtime',
            prompt: 'look for an sdk, runtime, aspnetcore runtime, etc',
        });

        try
        {
            const result = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.availableInstalls', { architecture: arch, requestingExtensionId: requestingExtensionId, mode: searchMode, dotnetExecutablePath: dotnetPath });
            vscode.window.showInformationMessage(`.NET Discovered:\n
${JSON.stringify(result) ?? 'undefined'}`);
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    context.subscriptions.push(
        sampleHelloWorldRegistration,
        sampleAcquireRegistration,
        sampleAcquireASPNETRegistration,
        sampleAcquireStatusRegistration,
        sampleDotnetUninstallAllRegistration,
        sampleAcquireSDKRegistration,
        sampleAcquireSDKStatusRegistration,
        sampleUninstallSDKRegistration,
        sampleUninstallAllSDKRegistration,
        sampleConcurrentTest,
        sampleConcurrentASPNETTest,
        sampleShowAcquisitionLogRegistration,
        sampleGetAcquisitionLogRegistration,
        sampleFindPathRegistration,
        sampleAvailableInstallsRegistration
    );

    const sampleForceUpdateRegistration = vscode.commands.registerCommand('sample.dotnet.forceUpdate', async () =>
    {
        try
        {
            // Call the forceUpdate command from the runtime extension
            await vscode.commands.executeCommand('dotnet.forceUpdate', { requestingExtensionId });
        }
        catch (error)
        {
            vscode.window.showErrorMessage((error as Error).toString());
        }
    });

    context.subscriptions.push(
        sampleForceUpdateRegistration,
        sampleGlobalSDKFromRuntimeRegistration,
        sampleResetUpdateSuccessTime,
        sampleAcquireNoForceRegistration);
}