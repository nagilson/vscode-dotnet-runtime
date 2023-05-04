/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import rimraf = require('rimraf');
import * as proc from 'child_process';
import * as https from 'https';
import * as vscode from 'vscode';

import {
    DotnetAcquisitionAlreadyInstalled,
    DotnetAcquisitionDeletion,
    DotnetAcquisitionInProgress,
    DotnetAcquisitionPartialInstallation,
    DotnetAcquisitionStarted,
    DotnetAcquisitionStatusResolved,
    DotnetAcquisitionStatusUndefined,
    DotnetPreinstallDetected,
    DotnetPreinstallDetectionError,
    DotnetUninstallAllCompleted,
    DotnetUninstallAllStarted,
} from '../EventStream/EventStreamEvents';
import { IDotnetAcquireResult } from '../IDotnetAcquireResult';
import { IAcquisitionWorkerContext } from './IAcquisitionWorkerContext';
import { IDotnetCoreAcquisitionWorker } from './IDotnetCoreAcquisitionWorker';
import { IDotnetInstallationContext } from './IDotnetInstallationContext';
import { GlobalSDKInstallerResolver } from './GlobalSDKInstallerResolver';
import { createSemanticDiagnosticsBuilderProgram } from 'typescript';
import { FileUtilities } from '../Utils/FileUtilities';
import { WebRequestWorker } from '../Utils/WebRequestWorker';

export class DotnetCoreAcquisitionWorker implements IDotnetCoreAcquisitionWorker {
    private readonly installingVersionsKey = 'installing';
    private readonly installedVersionsKey = 'installed';
    private readonly dotnetExecutable: string;
    private readonly timeoutValue: number;

    private acquisitionPromises: { [version: string]: Promise<string> | undefined };

    constructor(private readonly context: IAcquisitionWorkerContext) {
        const dotnetExtension = os.platform() === 'win32' ? '.exe' : '';
        this.dotnetExecutable = `dotnet${dotnetExtension}`;
        this.timeoutValue = context.timeoutValue;
        this.acquisitionPromises = {};
    }

    public async uninstallAll() {
        this.context.eventStream.post(new DotnetUninstallAllStarted());

        this.acquisitionPromises = {};

        this.removeFolderRecursively(this.context.installDirectoryProvider.getStoragePath());

        await this.context.extensionState.update(this.installingVersionsKey, []);
        await this.context.extensionState.update(this.installedVersionsKey, []);

        this.context.eventStream.post(new DotnetUninstallAllCompleted());
    }

    /**
     *
     * @remarks this is simply a wrapper around the acquire function.
     * @returns the requested dotnet path.
     */
    public async acquireSDK(version: string): Promise<IDotnetAcquireResult> {
        return this.acquire(version, false);
    }

    public async acquireGlobalSDK(installerResolver: GlobalSDKInstallerResolver): Promise<IDotnetAcquireResult>
    {
        return this.acquire(await installerResolver.getFullVersion(), false, installerResolver);
    }

    /**
     *
     * @remarks this is simply a wrapper around the acquire function.
     * @returns the requested dotnet path.
     */
    public async acquireRuntime(version: string): Promise<IDotnetAcquireResult> {
        return this.acquire(version, true);
    }

    public async acquireStatus(version: string, installRuntime: boolean): Promise<IDotnetAcquireResult | undefined> {
        const existingAcquisitionPromise = this.acquisitionPromises[version];
        if (existingAcquisitionPromise) {
            // Requested version is being acquired
            this.context.eventStream.post(new DotnetAcquisitionStatusResolved(version));
            return existingAcquisitionPromise.then((res) => ({ dotnetPath: res }));
        }

        const dotnetInstallDir = this.context.installDirectoryProvider.getInstallDir(version);
        const dotnetPath = path.join(dotnetInstallDir, this.dotnetExecutable);
        let installedVersions = this.context.extensionState.get<string[]>(this.installedVersionsKey, []);

        if (installedVersions.length === 0 && fs.existsSync(dotnetPath) && !installRuntime)
        {
            // The education bundle already laid down a local install, add it to our managed installs
            installedVersions = await this.managePreinstalledVersion(dotnetInstallDir, installedVersions);
        }

        if (installedVersions.includes(version) && fs.existsSync(dotnetPath))
        {
            // Requested version has already been installed.
            this.context.eventStream.post(new DotnetAcquisitionStatusResolved(version));
            return { dotnetPath };
        }

        // Version is not installed
        this.context.eventStream.post(new DotnetAcquisitionStatusUndefined(version));
        return undefined;
    }

    /**
     *
     * @param version the version to get of the runtime or sdk.
     * @param installRuntime true for runtime acquisition, false for SDK.
     * @param global false for local install, true for global SDK installs.
     * @returns the dotnet acqusition result.
     */
    private async acquire(version: string, installRuntime: boolean, globalInstallerResolver : GlobalSDKInstallerResolver | null = null): Promise<IDotnetAcquireResult> {
        /*const existingAcquisitionPromise = this.acquisitionPromises[version];
        if (existingAcquisitionPromise)
        {
            // This version of dotnet is already being acquired. Memoize the promise.
            this.context.eventStream.post(new DotnetAcquisitionInProgress(version));
            return existingAcquisitionPromise.then((res) => ({ dotnetPath: res }));
        }
        */ // todo uncomment this as it needs to be done to debug in mac if it hangs 
        //else
        //{
            // We're the only one acquiring this version of dotnet, start the acquisition process.
            let acquisitionPromise = null;
            if(globalInstallerResolver !== null)
            {
                // We are requesting a global sdk install.
                acquisitionPromise = this.acquireGlobalCore(globalInstallerResolver).catch((error: Error) => {
                    delete this.acquisitionPromises[version];
                    throw new Error(`.NET Acquisition Failed: ${error.message}`);
                });
            }
            else
            {
                acquisitionPromise = this.acquireCore(version, installRuntime).catch((error: Error) => {
                    delete this.acquisitionPromises[version];
                    throw new Error(`.NET Acquisition Failed: ${error.message}`);
                });
            }

            this.acquisitionPromises[version] = acquisitionPromise;
            return acquisitionPromise.then((res) => ({ dotnetPath: res }));
        //}
    }

    /**
     *
     * @param version The version of the object to acquire.
     * @param installRuntime true if the request is to install the runtime, false for the SDK.
     * @param global false if we're doing a local install, true if we're doing a global install. Only supported for the SDK atm.
     * @returns the dotnet path of the acquired dotnet.
     *
     * @remarks it is called "core" because it is the meat of the actual acquisition work; this has nothing to do with .NET core vs framework.
     */
    private async acquireCore(version: string, installRuntime: boolean): Promise<string> {
        const installingVersions = this.context.extensionState.get<string[]>(this.installingVersionsKey, []);
        let installedVersions = this.context.extensionState.get<string[]>(this.installedVersionsKey, []);
        const partialInstall = installingVersions.indexOf(version) >= 0;
        if (partialInstall && installRuntime) {
            // Partial install, we never updated our extension to no longer be 'installing'.
            // uninstall everything and then re-install.
            this.context.eventStream.post(new DotnetAcquisitionPartialInstallation(version));

            await this.uninstallRuntime(version);
        } else if (partialInstall) {
            this.context.eventStream.post(new DotnetAcquisitionPartialInstallation(version));
            await this.uninstallAll();
        }

        const dotnetInstallDir = this.context.installDirectoryProvider.getInstallDir(version);
        const dotnetPath = path.join(dotnetInstallDir, this.dotnetExecutable);

        if (fs.existsSync(dotnetPath) && installedVersions.length === 0) {
            // The education bundle already laid down a local install, add it to our managed installs
            installedVersions = await this.managePreinstalledVersion(dotnetInstallDir, installedVersions);
        }

        if (installedVersions.includes(version) && fs.existsSync(dotnetPath)) {
            // Version requested has already been installed.
            this.context.installationValidator.validateDotnetInstall(version, dotnetPath);
            this.context.eventStream.post(new DotnetAcquisitionAlreadyInstalled(version));
            return dotnetPath;
        }

        // We update the extension state to indicate we're starting a .NET Core installation.
        await this.addVersionToExtensionState(this.installingVersionsKey, version);

        const installContext = {
            installDir: dotnetInstallDir,
            version,
            dotnetPath,
            timeoutValue: this.timeoutValue,
            installRuntime,
        } as IDotnetInstallationContext;
        this.context.eventStream.post(new DotnetAcquisitionStarted(version));
        await this.context.acquisitionInvoker.installDotnet(installContext).catch((reason) => {
            throw Error(`Installation failed: ${reason}`);
        });
        this.context.installationValidator.validateDotnetInstall(version, dotnetPath);

        await this.removeVersionFromExtensionState(this.installingVersionsKey, version);
        await this.addVersionToExtensionState(this.installedVersionsKey, version);

        return dotnetPath;
    }

    private async acquireGlobalCore(globalInstallerResolver : GlobalSDKInstallerResolver): Promise<string>
    {
        const conflictingVersion = await globalInstallerResolver.GlobalInstallWithConflictingVersionAlreadyExists()
        if (conflictingVersion !== '')
        {
            throw Error(`An global install is already on the machine with a version that conflicts with the requested version.`)
        }

        // TODO fix handling with empty input split
        // TODO check if theres a partial install from the extension if that can happen
        // TODO fix registry check
        // TODO report installer OK if conflicting exists

        const installerUrl : string = await globalInstallerResolver.getInstallerUrl();
        const installerFile : string = await this.downloadInstallerOnMachine(installerUrl);

        const installingVersion = await globalInstallerResolver.getFullVersion();
        await this.addVersionToExtensionState(this.installingVersionsKey, installingVersion);

        this.context.eventStream.post(new DotnetAcquisitionStarted(installingVersion));
        const installerResult : string = await this.executeInstaller(installerFile);
        if(installerResult !== '0')
        {
            // TODO handle this.
        }
        const installedSDKPath : string = this.getGloballyInstalledSDKPath(await globalInstallerResolver.getFullVersion(), os.arch());
        this.wipeDirectory(path.dirname(installerFile));

        // TODO: Add exe to path.
        //this.context.installationValidator.validateDotnetInstall(installingVersion, installedSDKPath);

        // TODO see if the below is needed
        await this.removeVersionFromExtensionState(this.installingVersionsKey, installingVersion);
        await this.addVersionToExtensionState(this.installedVersionsKey, installingVersion);

        return installedSDKPath;
    }

    private async uninstallRuntime(version: string) {
        delete this.acquisitionPromises[version];

        const dotnetInstallDir = this.context.installDirectoryProvider.getInstallDir(version);
        this.removeFolderRecursively(dotnetInstallDir);

        await this.removeVersionFromExtensionState(this.installedVersionsKey, version);
        await this.removeVersionFromExtensionState(this.installingVersionsKey, version);
    }

    private async removeVersionFromExtensionState(key: string, version: string) {
        const state = this.context.extensionState.get<string[]>(key, []);
        const versionIndex = state.indexOf(version);
        if (versionIndex >= 0) {
            state.splice(versionIndex, 1);
            await this.context.extensionState.update(key, state);
        }
    }

    private async addVersionToExtensionState(key: string, version: string) {
        const state = this.context.extensionState.get<string[]>(key, []);
        state.push(version);
        await this.context.extensionState.update(key, state);
    }

    private removeFolderRecursively(folderPath: string) {
        this.context.eventStream.post(new DotnetAcquisitionDeletion(folderPath));
        rimraf.sync(folderPath);
    }

    private async managePreinstalledVersion(dotnetInstallDir: string, installedVersions: string[]): Promise<string[]> {
        try {
            // Determine installed version(s)
            const versions = fs.readdirSync(path.join(dotnetInstallDir, 'sdk'));

            // Update extension state
            for (const version of versions) {
                this.context.eventStream.post(new DotnetPreinstallDetected(version));
                await this.addVersionToExtensionState(this.installedVersionsKey, version);
                installedVersions.push(version);
            }
        } catch (error) {
            this.context.eventStream.post(new DotnetPreinstallDetectionError(error as Error));
        }
        return installedVersions;
    }

    /**
     *
     * @param installerUrl the url of the installer to download.
     * @returns the path to the installer which was downloaded into a directory managed by us.
     */
    private async downloadInstallerOnMachine(installerUrl : string) : Promise<string>
    {
        const ourInstallerDownloadFolder = DotnetCoreAcquisitionWorker.getInstallerDownloadFolder();
        this.wipeDirectory(ourInstallerDownloadFolder);
        const installerPath = path.join(ourInstallerDownloadFolder, `${installerUrl.split('/').slice(-1)}`);
        await this.download(installerUrl, installerPath);
        return installerPath;
    }

    private async download(url : string, dest : string) {
        return new Promise<void>((resolve, reject) => {

            const installerDir = path.dirname(dest);
            if (!fs.existsSync(installerDir)){
                fs.mkdirSync(installerDir);
            }
            const file = fs.createWriteStream(dest, { flags: "wx" });

            const request = https.get(url, response => {
                if (response.statusCode === 200) {
                    response.pipe(file);
                } else {
                    file.close();
                    fs.unlink(dest, () => {}); // Delete temp file
                    reject(`Server responded with ${response.statusCode}: ${response.statusMessage}`);
                }
            });

            request.on("error", err => {
                file.close();
                fs.unlink(dest, () => {}); // Delete temp file
                reject(err.message);
            });

            file.on("finish", () => {
                resolve();
            });

            file.on("error", err => {
                file.close();

                if (err.message === "EEXIST")
                {
                    reject("File already exists");
                }
                else
                {
                    fs.unlink(dest, () => {}); // Delete temp file
                    reject(err.message);
                }
            });
        });
    }

    /**
     *
     * @returns true if the process is running with admin privelleges on windows.
     */
    public static isElevated() : boolean
    {
        if(os.platform() !== 'win32')
        {
            const commandResult = proc.spawnSync("id", ["-u"]);
            return commandResult.status === 0;
        }

        try
        {
            // If we can execute this command on Windows then we have admin rights.
            proc.execFileSync( "net", ["session"], { "stdio": "ignore" } );
            return true;
        }
        catch ( error )
        {
            return false;
        }
    }

    private getGloballyInstalledSDKPath(specificSDKVersionInstalled : string, installedArch : string) : string
    {
        if(os.platform() === 'win32')
        {
            if(installedArch === 'x32')
            {
                return path.join(`C:\\Program Files (x86)\\dotnet\\sdk\\`, specificSDKVersionInstalled);
            }
            else if(installedArch === 'x64')
            {
                return path.join(`C:\\Program Files\\dotnet\\sdk\\`, specificSDKVersionInstalled);
            }
        }
        else if(os.platform() === 'darwin')
        {
            if(installedArch !== 'x64')
            {
                return path.join(`/usr/local/share/dotnet/sdk`, specificSDKVersionInstalled);
            }
            else
            {
                // We only know this to be correct in the ARM scenarios but I decided to assume the default is the same elsewhere.
                return path.join(`/usr/local/share/dotnet/x64/dotnet/sdk`, specificSDKVersionInstalled);
            }
        }

        // TODO check this on mac and linux it should be root. and check security of returning this
        return '';
    }

    /**
     *
     * @param directoryToWipe the directory to delete all of the files in if privellege to do so exists.
     */
    private wipeDirectory(directoryToWipe : string)
    {
        fs.readdir(directoryToWipe, (err, files) => {
            if (err) throw err;

            for (const file of files) {
              fs.unlink(path.join(directoryToWipe, file), (err) => {
                if (err) throw err;
              });
            }
          });
    }

    /**
     *
     * @returns The folder where global sdk installers will be downloaded onto the disk.
     */
    public static getInstallerDownloadFolder() : string
    {
        return path.join(__dirname, 'installers');
    }

    /**
     *
     * @param installerPath The path to the installer file to run.
     * @returns The exit code from running the global install.
     */
    private async executeInstaller(installerPath : string) : Promise<string>
    {
        // TODO: Handle this differently depending on the package type.
        let installCommand = `${path.resolve(installerPath)}`;
        let sudoPassword : string | undefined = '';

        if(os.platform() === 'darwin')
        {
            // For Mac:
            // We need to run the .NET SDK installer under sudo, otherwise it will return success without doing anything.
            // We also get a .pkg file which we cannot just run, we must forward it to the OSX installer utility.
            // The Mac installer utility does not allow you to pass arguments in to the pkg under execution, so we cannot rely on the flags passed to the installer here.

            // To run a command under sudo, we need to prompt the user for their password.
            // We MUST make sure that this does NOT get echo'd out anywhere.

            // The sudo command is wrapped in a sh to allow us to forward the sudo arguments correctly.
            // The command for sudo to run is wrapped in bash to allow the arguments to the installer command to flow correctly.
            installCommand = `open`
            const commandResult = proc.spawnSync('open', ['-W', `${path.resolve(installerPath)}`]);
            return commandResult.toString();
        }

        try
        {
            const commandResult = proc.spawnSync(installCommand, DotnetCoreAcquisitionWorker.isElevated() ? ['/quiet', '/install', '/norestart'] : []);
            return commandResult.toString();
        }
        catch(error : any)
        {
            return error;
        }
    }
}

