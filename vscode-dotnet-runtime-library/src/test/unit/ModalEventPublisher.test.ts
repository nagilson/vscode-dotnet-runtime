/*---------------------------------------------------------------------------------------------
*  Licensed to the .NET Foundation under one or more agreements.
*  The .NET Foundation licenses this file to you under the MIT license.
*--------------------------------------------------------------------------------------------*/
import * as chai from 'chai';
import * as os from 'os';
import { GetDotnetInstallInfo } from '../../Acquisition/DotnetInstall';
import
{
    DotnetAcquisitionFinalError,
    DotnetAcquisitionRequested,
    DotnetAcquisitionStarted,
    DotnetAcquisitionTotalSuccessEvent,
    DotnetGlobalSDKAcquisitionError,
    DotnetGlobalSDKAcquisitionRequested,
    DotnetGlobalSDKAcquisitionStarted,
    DotnetGlobalSDKAcquisitionTotalSuccessEvent,
    DotnetLocalSDKAcquisitionError,
    DotnetLocalSDKAcquisitionRequested,
    DotnetLocalSDKAcquisitionStarted,
    DotnetLocalSDKAcquisitionTotalSuccessEvent,
} from '../../EventStream/EventStreamEvents';
import { ModalEventRepublisher } from '../../EventStream/ModalEventPublisher';
import { DotnetInstallType } from '../../IDotnetAcquireContext';
import { MockEventStream } from '../mocks/MockObjects';

const assert = chai.assert;
const version = '8.0.408';

function sdkInstall(installType: DotnetInstallType)
{
    return GetDotnetInstallInfo(version, 'sdk', installType, os.arch());
}

suite('ModalEventRepublisher Unit Tests', function ()
{
    test('Republishes sdk + local acquisition events as DotnetLocalSDK* variants', function ()
    {
        const stream = new MockEventStream();
        const republisher = new ModalEventRepublisher(stream);
        const install = sdkInstall('local');

        republisher.post(new DotnetAcquisitionStarted(install, version, 'ext'));
        republisher.post(new DotnetAcquisitionTotalSuccessEvent(version, install, 'ext', '/path/dotnet'));
        republisher.post(new DotnetAcquisitionRequested(version, 'ext', 'sdk', 'local'));
        republisher.post(new DotnetAcquisitionFinalError(new Error('boom'), 'DotnetAcquisitionStarted', install));

        assert.exists(stream.events.find(e => e instanceof DotnetLocalSDKAcquisitionStarted), 'Started');
        assert.exists(stream.events.find(e => e instanceof DotnetLocalSDKAcquisitionTotalSuccessEvent), 'TotalSuccess');
        assert.exists(stream.events.find(e => e instanceof DotnetLocalSDKAcquisitionRequested), 'Requested');
        assert.exists(stream.events.find(e => e instanceof DotnetLocalSDKAcquisitionError), 'FinalError');
    });

    test('Still republishes sdk + global acquisition events as DotnetGlobalSDK* variants', function ()
    {
        const stream = new MockEventStream();
        const republisher = new ModalEventRepublisher(stream);
        const install = sdkInstall('global');

        republisher.post(new DotnetAcquisitionStarted(install, version, 'ext'));
        republisher.post(new DotnetAcquisitionTotalSuccessEvent(version, install, 'ext', '/path/dotnet'));
        republisher.post(new DotnetAcquisitionRequested(version, 'ext', 'sdk', 'global'));
        republisher.post(new DotnetAcquisitionFinalError(new Error('boom'), 'DotnetAcquisitionStarted', install));

        assert.exists(stream.events.find(e => e instanceof DotnetGlobalSDKAcquisitionStarted), 'Started');
        assert.exists(stream.events.find(e => e instanceof DotnetGlobalSDKAcquisitionTotalSuccessEvent), 'TotalSuccess');
        assert.exists(stream.events.find(e => e instanceof DotnetGlobalSDKAcquisitionRequested), 'Requested');
        assert.exists(stream.events.find(e => e instanceof DotnetGlobalSDKAcquisitionError), 'FinalError');
        assert.notExists(stream.events.find(e => e instanceof DotnetLocalSDKAcquisitionStarted), 'No local variant for global');
    });
});
