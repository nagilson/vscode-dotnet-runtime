/*---------------------------------------------------------------------------------------------
*  Licensed to the .NET Foundation under one or more agreements.
*  The .NET Foundation licenses this file to you under the MIT license.
*--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { IInstallationDirectoryProvider } from './IInstallationDirectoryProvider';

export class SdkInstallationDirectoryProvider extends IInstallationDirectoryProvider
{
    public getInstallDir(installId: string): string
    {
        // SDK installs are isolated by install id.
        return path.join(this.getStoragePath(), installId);
    }
}
