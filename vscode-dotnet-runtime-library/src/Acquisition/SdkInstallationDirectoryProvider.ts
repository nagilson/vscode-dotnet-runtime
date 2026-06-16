/*---------------------------------------------------------------------------------------------
*  Licensed to the .NET Foundation under one or more agreements.
*  The .NET Foundation licenses this file to you under the MIT license.
*--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { IInstallationDirectoryProvider } from './IInstallationDirectoryProvider';

export class SdkInstallationDirectoryProvider extends IInstallationDirectoryProvider {
    public getInstallDir(installId: string): string {
        // Each SDK gets its own folder (its own DOTNET_ROOT). A shared root would let dotnet discover
        // sibling SDK versions and would make uninstalling one SDK wipe every other install under .dotnet.
        return path.join(this.getStoragePath(), installId);
    }
}
