/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as eol from 'eol';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import { IEventStream } from '../EventStream/EventStream';
import {
    DotnetFallbackInstallScriptUsed,
    DotnetFileWriteRequestEvent,
    DotnetInstallScriptAcquisitionCompleted,
    DotnetInstallScriptAcquisitionError,
    DotnetLockAcquiredEvent,
    DotnetLockAttemptingAcquireEvent,
    DotnetLockErrorEvent,
    DotnetLockReleasedEvent,
} from '../EventStream/EventStreamEvents';
import { IExtensionState } from '../IExtensionState';
import { WebRequestWorker } from '../Utils/WebRequestWorker';
import { Debugging } from '../Utils/Debugging';
import { IInstallScriptAcquisitionWorker } from './IInstallScriptAcquisitionWorker';
import { FileUtilities } from '../Utils/FileUtilities';

export class InstallScriptAcquisitionWorker implements IInstallScriptAcquisitionWorker {
    protected webWorker: WebRequestWorker;
    private readonly scriptAcquisitionUrl: string = 'https://dot.net/v1/dotnet-install.';
    private readonly scriptFilePath: string;
    private readonly fileUtilities: FileUtilities;


    constructor(extensionState: IExtensionState, private readonly eventStream: IEventStream, private readonly timeoutTime : number) {
        const scriptFileEnding = os.platform() === 'win32' ? 'ps1' : 'sh';
        const scriptFileName = 'dotnet-install';
        this.scriptFilePath = path.join(__dirname, 'install scripts', `${scriptFileName}.${scriptFileEnding}`);
        this.webWorker = new WebRequestWorker(extensionState, eventStream, this.scriptAcquisitionUrl + scriptFileEnding, this.timeoutTime * 1000);
        this.fileUtilities = new FileUtilities();
    }

    public async getDotnetInstallScriptPath(): Promise<string> {
        try
        {
            Debugging.log('getDotnetInstallScriptPath() invoked.');
            const script = await this.webWorker.getCachedData();
            if (!script) {
                Debugging.log('The request to acquire the script failed.');
                throw new Error('Unable to get script path.');
            }

            Debugging.log('Writing the dotnet install script into a file.');
            await this.fileUtilities.writeFileOntoDisk(script, this.scriptFilePath);
            Debugging.log('The dotnet install script has been successfully written to disk. Returning the path.');
            this.eventStream.post(new DotnetInstallScriptAcquisitionCompleted());
            return this.scriptFilePath;
        }
        catch (error)
        {
            Debugging.log('An error occured processing the install script.');
            this.eventStream.post(new DotnetInstallScriptAcquisitionError(error as Error));

            // Try to use fallback install script
            const fallbackPath = this.getFallbackScriptPath();
            if (fs.existsSync(fallbackPath)) {
                Debugging.log('Returning the fallback script path.');
                this.eventStream.post(new DotnetFallbackInstallScriptUsed());
                return fallbackPath;
            }

            throw new Error(`Failed to Acquire Dotnet Install Script: ${error}`);
        }
    }

    protected getFallbackScriptPath(): string {
        return this.scriptFilePath;
    }
}
