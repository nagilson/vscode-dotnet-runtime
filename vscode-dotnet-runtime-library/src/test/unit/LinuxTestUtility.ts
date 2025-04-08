import { DistroVersionPair } from '../../Acquisition/DistroVersionPair';
import { IAcquisitionWorkerContext } from '../../Acquisition/IAcquisitionWorkerContext';
import { LinuxVersionResolver } from '../../Acquisition/LinuxVersionResolver';
import { RED_HAT_DISTRO_INFO_KEY, UBUNTU_DISTRO_INFO_KEY } from '../../Acquisition/StringConstants';
import { getMockUtilityContext } from './TestUtility';


export async function getDistroInfo(context: IAcquisitionWorkerContext): Promise<DistroVersionPair>
{
    return new LinuxVersionResolver(context, getMockUtilityContext()).getRunningDistro();
}
/**
 *
 * @param distroInfo The distro and version of the system
 * @returns The built-in distro supported version of the .NET SDK.
 * Only maintaining the microsoft supported versions for now.
 */

export async function getLinuxSupportedDotnetSDKVersion(context: IAcquisitionWorkerContext, distroInfo?: DistroVersionPair): Promise<string>
{
    distroInfo ??= await getDistroInfo(context);

    if (distroInfo.distro === UBUNTU_DISTRO_INFO_KEY)
    {
        if (distroInfo.version < '22.04')
        {
            return '6.0.100';
        }
        if (distroInfo.version < '24.04')
        {
            return '9.0.100';
        }

        else
        {
            return '8.0.100';
        }
    }
    else if (distroInfo.distro === RED_HAT_DISTRO_INFO_KEY)
    {
        if (distroInfo.version < '8.0')
        {
            return '7.0.100';
        }

        else
        {
            return '9.0.100';
        }
    }
    return getLatestLinuxDotnet(); // best effort guess for latest 'dotnet' version atm.
}

export function getLatestLinuxDotnet()
{
    return '9.0.100';
}
