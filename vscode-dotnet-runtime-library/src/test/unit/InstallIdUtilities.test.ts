/*---------------------------------------------------------------------------------------------
*  Licensed to the .NET Foundation under one or more agreements.
*  The .NET Foundation licenses this file to you under the MIT license.
*--------------------------------------------------------------------------------------------*/
import * as chai from 'chai';
import { getAssumedInstallInfo, getInstallIdCustomArchitecture, isRuntimeInstallId } from '../../Utils/InstallIdUtilities';

const assert = chai.assert;

suite('InstallIdUtilities Unit Tests', function ()
{
    this.timeout(15000);

    suite('getInstallIdCustomArchitecture', function ()
    {
        test('marks a local SDK id with ~sdk', function ()
        {
            assert.equal(getInstallIdCustomArchitecture('8.0.408', 'x64', 'sdk', 'local'), '8.0.408~x64~sdk');
        });

        test('marks a local aspnetcore id with ~aspnetcore', function ()
        {
            assert.equal(getInstallIdCustomArchitecture('8.0.5', 'x64', 'aspnetcore', 'local'), '8.0.5~x64~aspnetcore');
        });

        test('leaves a local runtime id unmarked', function ()
        {
            assert.equal(getInstallIdCustomArchitecture('8.0.5', 'x64', 'runtime', 'local'), '8.0.5~x64');
        });

        test('leaves a global SDK id unmarked (no ~sdk)', function ()
        {
            assert.equal(getInstallIdCustomArchitecture('8.0.408', 'x64', 'sdk', 'global'), '8.0.408-global~x64');
        });
    });

    suite('isRuntimeInstallId', function ()
    {
        test('treats a ~sdk local id as not a runtime', function ()
        {
            assert.isFalse(isRuntimeInstallId('8.0.408~x64~sdk'));
        });

        test('treats non-runtime mode markers as not runtime even when the version looks like a runtime', function ()
        {
            assert.isFalse(isRuntimeInstallId('8.0.5~x64~sdk'));
            assert.isFalse(isRuntimeInstallId('8.0.5~x64~aspnetcore'));
        });

        test('treats an unmarked local id as a runtime', function ()
        {
            assert.isTrue(isRuntimeInstallId('8.0.5~x64'));
        });
    });

    suite('getAssumedInstallInfo', function ()
    {
        test('honors an explicit sdk mode', function ()
        {
            assert.equal(getAssumedInstallInfo('8.0.408~x64~sdk', 'sdk').installMode, 'sdk');
        });

        test('honors an explicit aspnetcore mode', function ()
        {
            assert.equal(getAssumedInstallInfo('8.0.5~x64~aspnetcore', 'aspnetcore').installMode, 'aspnetcore');
        });

        test('infers runtime from a legacy id when no mode is given', function ()
        {
            assert.equal(getAssumedInstallInfo('8.0.5', null).installMode, 'runtime');
        });

        test('infers sdk from a legacy sdk id when no mode is given', function ()
        {
            assert.equal(getAssumedInstallInfo('8.0.408~x64~sdk', null).installMode, 'sdk');
        });
    });
});
