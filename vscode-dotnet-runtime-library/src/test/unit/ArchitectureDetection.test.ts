/*---------------------------------------------------------------------------------------------
*  Licensed to the .NET Foundation under one or more agreements.
*  The .NET Foundation licenses this file to you under the MIT license.
*--------------------------------------------------------------------------------------------*/
import * as chai from 'chai';
import
{
    architectureCanRunOnHost,
    canonicalCpuArchitecture,
    getWindowsTrueOSArch,
    resolveHostCompatibleArchitecture
} from '../../Utils/TypescriptUtilities';

const assert = chai.assert;

suite('Architecture Detection Unit Tests', () =>
{
    suite('canonicalCpuArchitecture', () =>
    {
        test('Maps the various x64 spellings to x64', () =>
        {
            for (const spelling of ['x64', 'X64', 'amd64', 'AMD64', 'x86_64', 'x86-64', 'i386'])
            {
                assert.equal(canonicalCpuArchitecture(spelling), 'x64', `${spelling} should canonicalize to x64`);
            }
        });

        test('Maps the various x86 spellings to x86', () =>
        {
            for (const spelling of ['x86', 'ia32', 'IA32', 'i686'])
            {
                assert.equal(canonicalCpuArchitecture(spelling), 'x86', `${spelling} should canonicalize to x86`);
            }
        });

        test('Maps the various arm64 spellings to arm64', () =>
        {
            for (const spelling of ['arm64', 'ARM64', 'aarch64', 'arm'])
            {
                assert.equal(canonicalCpuArchitecture(spelling), 'arm64', `${spelling} should canonicalize to arm64`);
            }
        });

        test('Passes through unknown architectures lowercased and handles null/undefined', () =>
        {
            assert.equal(canonicalCpuArchitecture('s390x'), 's390x');
            assert.equal(canonicalCpuArchitecture(null), '');
            assert.equal(canonicalCpuArchitecture(undefined), '');
        });
    });

    suite('architectureCanRunOnHost', () =>
    {
        test('Same architecture always runs', () =>
        {
            assert.isTrue(architectureCanRunOnHost('x64', 'x64'));
            assert.isTrue(architectureCanRunOnHost('arm64', 'arm64'));
            assert.isTrue(architectureCanRunOnHost('amd64', 'x64'), 'canonical equivalents should match');
        });

        test('x64 and x86 run on an arm64 host via emulation', () =>
        {
            assert.isTrue(architectureCanRunOnHost('x64', 'arm64'));
            assert.isTrue(architectureCanRunOnHost('x86', 'arm64'));
            assert.isTrue(architectureCanRunOnHost('x64', 'arm'), 'macOS uname -p reports arm');
        });

        test('x86 runs on an x64 host via WOW64', () =>
        {
            assert.isTrue(architectureCanRunOnHost('x86', 'x64'));
        });

        test('arm64 cannot run on an x64 or x86 host (the issue #2712 case)', () =>
        {
            assert.isFalse(architectureCanRunOnHost('arm64', 'x64'));
            assert.isFalse(architectureCanRunOnHost('arm64', 'x86'));
        });

        test('x64 cannot run on an x86 host', () =>
        {
            assert.isFalse(architectureCanRunOnHost('x64', 'x86'));
        });

        test('Unknown architectures are treated as runnable so installs are never blocked', () =>
        {
            assert.isTrue(architectureCanRunOnHost('s390x', 'x64'));
            assert.isTrue(architectureCanRunOnHost('x64', ''));
        });
    });

    suite('resolveHostCompatibleArchitecture', () =>
    {
        test('Matching architecture is reported as matches and left unchanged', () =>
        {
            const result = resolveHostCompatibleArchitecture('x64', 'x64', true);
            assert.equal(result.architecture, 'x64');
            assert.equal(result.outcome, 'matches');
            assert.isFalse(result.corrected);
            assert.isFalse(result.differsFromHost);
        });

        test('x64 under emulation on arm64 is kept (we do NOT force native under emulation)', () =>
        {
            const result = resolveHostCompatibleArchitecture('x64', 'arm64', false);
            assert.equal(result.architecture, 'x64', 'should keep x64, not switch to arm64');
            assert.equal(result.outcome, 'emulated');
            assert.isFalse(result.corrected);
            assert.isTrue(result.differsFromHost);
            assert.isTrue(result.runnableOnHost);
        });

        test('An explicit caller request for a non-runnable architecture is honored (with a flag to warn)', () =>
        {
            const result = resolveHostCompatibleArchitecture('arm64', 'x64', true);
            assert.equal(result.architecture, 'arm64', 'caller request must be respected');
            assert.equal(result.outcome, 'honored-incompatible');
            assert.isFalse(result.corrected);
            assert.isFalse(result.runnableOnHost);
        });

        test('A self-derived non-runnable architecture is corrected to the host architecture', () =>
        {
            const result = resolveHostCompatibleArchitecture('arm64', 'x64', false);
            assert.equal(result.architecture, 'x64', 'should be corrected to host');
            assert.equal(result.outcome, 'corrected');
            assert.isTrue(result.corrected);
            assert.isFalse(result.runnableOnHost);
        });

        test('Correction canonicalizes the host architecture spelling', () =>
        {
            const result = resolveHostCompatibleArchitecture('arm64', 'amd64', false);
            assert.equal(result.architecture, 'x64');
            assert.isTrue(result.corrected);
        });

        test('Canonically-equal architectures from different sources are treated as matching', () =>
        {
            const result = resolveHostCompatibleArchitecture('arm64', 'arm', true);
            assert.equal(result.outcome, 'matches');
            assert.isFalse(result.differsFromHost);
        });
    });

    suite('getWindowsTrueOSArch', () =>
    {
        const originalArchitew6432 = process.env.PROCESSOR_ARCHITEW6432;
        const originalArchitecture = process.env.PROCESSOR_ARCHITECTURE;

        function setProcessorEnv(architew6432: string | undefined, architecture: string | undefined): void
        {
            if (architew6432 === undefined)
            {
                delete process.env.PROCESSOR_ARCHITEW6432;
            }
            else
            {
                process.env.PROCESSOR_ARCHITEW6432 = architew6432;
            }

            if (architecture === undefined)
            {
                delete process.env.PROCESSOR_ARCHITECTURE;
            }
            else
            {
                process.env.PROCESSOR_ARCHITECTURE = architecture;
            }
        }

        teardown(() =>
        {
            setProcessorEnv(originalArchitew6432, originalArchitecture);
        });

        test('PROCESSOR_ARCHITEW6432 (set only while emulated) reports the true native architecture', () =>
        {
            // x64 VS Code emulated on an ARM64 Windows OS: PROCESSOR_ARCHITECTURE=AMD64 but PROCESSOR_ARCHITEW6432=ARM64.
            setProcessorEnv('ARM64', 'AMD64');
            assert.equal(getWindowsTrueOSArch(), 'arm64', 'emulation must surface the native arm64 arch');
        });

        test('Falls back to PROCESSOR_ARCHITECTURE when not emulated', () =>
        {
            setProcessorEnv(undefined, 'AMD64');
            assert.equal(getWindowsTrueOSArch(), 'x64');

            setProcessorEnv(undefined, 'ARM64');
            assert.equal(getWindowsTrueOSArch(), 'arm64');

            setProcessorEnv(undefined, 'x86');
            assert.equal(getWindowsTrueOSArch(), 'ia32');
        });
    });
});
