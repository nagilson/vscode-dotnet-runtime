# Migration Plan: Local SDK Acquisition into the .NET Install Tool

Move `local` + `sdk` acquisition out of the deprecated `vscode-dotnet-sdk-extension` and into
`dotnet.acquire` in the `.NET Install Tool` (`vscode-dotnet-runtime-extension`), then delete the
SDK extension entirely.

This document is **plan only**. No code is changed by this file. It is organized as a sequence of
small, independently reviewable commits.

---

## 0. Background and current-state findings

These findings come from reading the live code and determine the whole plan. Read them before
touching anything.

### 0.1 The acquire dispatch is the core gap

[vscode-dotnet-runtime-extension/src/extension.ts](vscode-dotnet-runtime-extension/src/extension.ts) →
`acquireLocal(...)` already:

- defaults `commandContext.mode` to `'runtime'`,
- builds the worker context via `getAcquisitionWorkerContext(mode, commandContext)`, which already
  selects the **correct directory provider per mode** (`directoryProviderFactory(mode, ...)`),
- posts the generic `DotnetAcquisitionRequested` and `DotnetAcquisitionTotalSuccessEvent`
  (both carry `installMode: mode`, so they are already SDK-aware),
- does **not** call `setPathEnvVar` (which is exactly what we want for local SDK).

The single functional gap is the final dispatch line:

```ts
return mode === 'aspnetcore' ? worker.acquireLocalASPNET(workerContext, acquisitionInvoker)
                             : worker.acquireLocalRuntime(workerContext, acquisitionInvoker);
```

There is **no `sdk` branch**. Worse, because the dispatch forces `acquireLocalRuntime` (which calls
`acquire(context, 'runtime', ...)`) while `getInstallCommand` derives its `-Runtime` flag from
`workerContext.acquisitionContext.mode` (still `'sdk'`, see 0.2), today's `dotnet.acquire {mode:'sdk'}`
lands in an **inconsistent** state: it runs the install script with no `-Runtime` flag (so it downloads
an **SDK binary**) but records it under a **runtime** install-id in the **shared** SDK directory. This
is nonsensical, which is exactly why the combination was never officially supported — and it means no
sane consumer can be relying on it (see audit 0.4). Fixing the dispatch is the primary change.

### 0.2 The library layer already supports local SDK

- `DotnetCoreAcquisitionWorker.acquireLocalSDK(context, invoker)` exists and calls
  `acquire(context, 'sdk', undefined, invoker)`.
- `acquire` / `acquireLocalCore` are mode-driven (install id, directory provider, validator are all
  derived from `mode`/context).
- `AcquisitionInvoker.getInstallCommand` adds **no** `-Runtime` flag when the mode is `sdk`, so the
  install script installs an SDK. (`runtime` → `-Runtime dotnet`, `aspnetcore` → `-Runtime aspnetcore`,
  `sdk` → nothing = SDK.) **Important:** it reads the mode from `workerContext.acquisitionContext.mode`,
  **not** from `install.installMode`. After the fix both are `'sdk'` and consistent; today they diverge
  (see 0.1 / 0.4).
- `acquireStatus(context, installMode)` is already mode-parameterized.

So most of the migration is **wiring + removing the SDK-extension-specific assumptions**, not new
acquisition logic.

### 0.3 Drifts / incorrect assumptions to correct (the important part)

1. **Runtime-version resolver shortcut + accepted version formats.** In `acquireLocal`:
   ```ts
   const runtimeVersionResolver = new VersionResolver(workerContext);
   commandContext.version = commandContext.version.split('.')?.length > 2
       ? commandContext.version
       : await runtimeVersionResolver.getFullVersion(commandContext.version, mode);
   ```
   - The variable name (`runtimeVersionResolver`) is misleading; it does pass `mode`, so it is
     functionally mode-aware.
   - The `split('.').length > 2` shortcut is a **runtime testing affordance**: a 3-part value bypasses
     resolution and is passed to the install script verbatim. This is how the runtime path "officially
     supports major.minor but also allows fully-specified versions for testing."
   - **What `VersionResolver.getFullVersion(_, 'sdk')` actually supports (verified): major.minor ONLY.**
     It resolves against `releases-index.json`, which has one entry per major.minor channel exposing
     `latest-sdk`. `resolveVersion` matches either the channel's *latest* full version or its
     `channelVersion` (the major.minor). Therefore:
     - `8.0` (major.minor) → resolves to the latest SDK patch (e.g. `8.0.408`). ✅
     - `8` (major only) → `validateVersionInput` rejects it (1 dot-part). ❌
     - `8.0.4xx` (feature band) → passes validation but `resolveVersion` finds no match → throws. ❌
     - `8.0.404` (fully specified) → via the resolver, only "works" if it equals the channel's newest
       SDK; any older patch throws. **But** the acquire command never sends a 3-part value to the
       resolver — the `>2` passthrough (Decision below) routes it straight to the install script — so a
       fully-specified patch installs fine. ✅ via passthrough
     The list above is the resolver in isolation. It matches what the deprecated SDK extension exposed,
     since that extension called `getFullVersion(version, 'sdk')` directly
     with **no** `>2` passthrough — so the education bundle was major.minor-only. Richer formats
     (major, feature band, fully specified) are a **`dotnet.acquireGlobalSDK`-only** capability, because
     only `GlobalInstallerResolver` does feature-band/patch resolution against the per-channel manifest.
   - **Decision (REVISED — explicit fully-specified SDK + early, mode-aware validation):** local SDK
     officially supports **two** formats: `major.minor` (e.g. `8.0`, resolved to the latest patch) and
     **fully-specified** (e.g. `8.0.408`, installed exactly). We do **not** lean on the runtime
     `>2`-passthrough as an implicit "testing" affordance for SDK; instead we **validate the version
     shape up front** so a bad version fails immediately with a clear message rather than deep in the
     install script. Reuse the library's existing, already-tested classifiers (the same trichotomy
     `GlobalInstallerResolver.getFullySpecifiedVersion` uses) — no new parsing:
     - `isFullySpecifiedVersion(v, es, ctx)` → `8.0.408` ⇒ accept, install exactly (passthrough).
     - `isNonSpecificMajorOrMajorMinorVersion(v)` **and** it is major.minor (2 parts) ⇒ resolve via
       `getFullVersion(v, 'sdk')`.
     - `isNonSpecificFeatureBandedVersion(v)` (`8.0.4xx`), bare major (`8`), or anything else ⇒ **throw
       early** with a message pointing at `dotnet.acquireGlobalSDK`.
   - **Why a mode branch is required (not optional):** `isFullySpecifiedVersion` is *SDK-shaped* — it
     requires a 2-digit band+patch, so `isFullySpecifiedVersion('9.0.0')` and `('8.0.11')` return
     **false** (and some runtime inputs even make the long-form helper post parse events). Runtime
     fully-specified versions therefore must **stay on the existing lenient `>2` passthrough**; only the
     SDK branch uses the strict classifiers. This is exactly the "keep existing validation and split on
     whether it's a runtime version or not" approach. (Supersedes the previous turn's "mirror runtime,
     no SDK branch" decision.)
   - **Early vs. late:** the early check validates *shape/format* (major-only, feature band, garbage →
     fail fast). A well-formed but non-existent patch (e.g. `8.0.999`) still passes the shape check and
     surfaces as a not-found from the install script — same as runtime `9.0.999`; we don't pre-flight
     existence.
   - Note: `VersionResolver.getReleasesInfo` already keys off mode (`listRuntimes: mode === 'runtime'
     || mode === 'aspnetcore'`), so SDK release metadata is fetched for `sdk`. Offline behavior is the
     same as runtime: the offline existing-install check runs *before* version resolution, so an
     existing matching local SDK is returned without the network.


2. **The `knownExtensionIds` gate is SDK-extension-only.** The SDK extension rejected any caller not
   in `['ms-dotnettools.sample-extension', 'ms-dotnettools.vscode-dotnet-pack']`. We **drop this gate**.
   `dotnet.acquire` keeps its current behavior: warn (not reject) when `requestingExtensionId` is
   missing.

3. **`setPathEnvVar` must NOT be ported.** The SDK extension's local branch called
   `new CommandExecutor(...).setPathEnvVar(...)`. We deliberately **do not** set PATH for local SDK.
   (Document this in `commands.md`.)

4. **Global request via `dotnet.acquire`.** `dotnet.acquire` is local-only. A `mode: 'sdk'` +
   `installType: 'global'` request must **fail clearly** (point users at `dotnet.acquireGlobalSDK`)
   rather than silently doing a local install. (User requirement: "fail if global is requested" since
   acquire does not delegate to the global command.)

5. **Add a `~sdk` marker to the install-id for LOCAL SDK installs (only).**
   Today `getInstallIdCustomArchitecture` marks only `aspnetcore` (`~aspnetcore`); runtime and SDK
   local both produce `${version}~${arch}`, so they are distinguished only by the disjoint
   version-number spaces plus the separate `installMode` field. Per maintainer direction we make the
   id **self-describing** instead of trusting that invariant: local SDK becomes `${version}~${arch}~sdk`
   (mirroring the existing `~aspnetcore` suffix). This hardens `IsEquivalentInstallation` (which is a
   pure `installId ===` comparison) so local SDK and local runtime can never collide on id.
   - **Do NOT mark GLOBAL sdk.** Global ids already carry `-global`, the extension only ever performs
     global *SDK* installs (not global runtime), and existing global-SDK records are a **shipping
     feature with real users**. Changing their id orphans those records, and the next
     `dotnet.acquireGlobalSDK` of that version would fail the `IsEquivalentInstallation` check, fall
     through to `acquireGlobalCore`, and **re-run the elevated installer → spurious UAC prompt +
     reinstall**. So leave global ids exactly as they are.
   - **No runtime orphaning** (your hard requirement): runtime ids are not touched.
   - **No local-SDK orphaning either, in practice:** the runtime extension has never tracked a local
     SDK. The deprecated SDK extension stored its records in its **own** per-extension `globalState`
     (`ms-dotnettools.vscode-dotnet-sdk`), which the runtime extension cannot read. So there are zero
     existing local-SDK records here to orphan — we don't even spend the "orphan budget" you offered.
   - **Parsing is already marker-aware — only the constructor changes:**
     - `isRuntimeInstallId` already filters `DOTNET_INSTALL_MODE_LIST` (which includes `'sdk'`) and
       checks `installId.includes(mode)`. With the marker it classifies via the explicit `~sdk` token
       instead of the fragile `looksLikeRuntimeVersion` digit-count heuristic — strictly more robust;
       **no change needed**.
     - `getVersionFromLegacyInstallId` (returns `split('~')[0]`) and `getArchFromLegacyInstallId`
       (returns `split('~')[1]`) are unaffected: `~sdk` is the **third** segment, exactly like
       `~aspnetcore`.
     - `getAssumedInstallInfo`, `existingLegacyInstalls`, and `removeMatchingLegacyInstall` operate
       only on *legacy* bare ids (no `~`); new SDK ids contain `~`, so they are untouched.
     - No test pins the local-SDK id string (the only literal id in any test is
       `10.0.5~x64~aspnetcore`, which confirms the `~<mode>` convention), so nothing breaks.

6. **`SdkInstallationDirectoryProvider` collapses every SDK into one shared folder — a latent
   data-loss bug that MUST be fixed before reusing it in the runtime extension.**
   `IInstallationDirectoryProvider.getStoragePath()` returns `<storagePath>/.dotnet`.
   - `RuntimeInstallationDirectoryProvider.getInstallDir(id)` → `<.dotnet>/<id>/` (one folder per install).
   - `SdkInstallationDirectoryProvider.getInstallDir(id)` → `<.dotnet>` (**the shared root; the id is ignored**).

   Where the old SDK extension actually stored things: it set `storagePath` to `%APPDATA%` (Windows)
   or `~/.vscode-dotnet-sdk` (non-Windows), and `getStoragePath()` appends `.dotnet`, so local SDKs
   lived at `%APPDATA%\.dotnet` (Windows) or `~/.vscode-dotnet-sdk/.dotnet` (non-Windows). Because the
   id is ignored, **every** local SDK landed in that single folder. That only ever "worked" because the
   education bundle (`vscode-dotnet-pack`) installed exactly one SDK.

   In the runtime extension `storagePath` is `vsCodeContext.globalStoragePath`, so the SDK provider's
   shared root is `<globalStorage>/.dotnet` — **the same root that already holds every local runtime
   sub-folder.** Reusing the provider unchanged would be catastrophic:
   - `uninstallLocal` runs `wipeDirectory(getInstallDir(installId))`. For the SDK provider that is the
     shared root, and `wipeDirectory` removes **all** entries recursively (verified: no extension
     filter ⇒ `fs.rm(entry, { recursive: true, force: true })` over every child). Uninstalling one
     local SDK would delete every other SDK **and every local runtime** under `.dotnet`.
   - In-use detection / wipe-protection keys off `path.dirname(exePath)` = the shared root, so one
     SDK's running host blocks (or fails to protect) all siblings.
   - A shared root is a single `DOTNET_ROOT`, so `dotnet --list-sdks` from the returned path surfaces
     every other installed SDK version and can change `global.json` / SDK resolution unexpectedly.

   **Fix (new Commit 1):** make `SdkInstallationDirectoryProvider.getInstallDir(id)` return
   `path.join(this.getStoragePath(), id)`, mirroring `RuntimeInstallationDirectoryProvider`, so each
   local SDK gets its own isolated folder (its own `DOTNET_ROOT`, its own uninstall/lock scope). This
   is the design you suggested and it is the correct one. It is **safe for the shipping global SDK
   path** because: global installs are placed/located via `getExpectedGlobalSDKPath` (a system
   location), never `getInstallDir`; and install **records + their mutex use the constant keys**
   `'installed'` / `'installedLk'` (`getLockFilePathForKeySimple`), independent of `getInstallDir`, so
   existing tracked installs are not moved or invalidated.

7. **Auto-update excludes SDK — keep it that way (but be explicit).** `LocalInstallUpdateService`
   filters `installMode !== 'sdk' && isGlobal !== true`, so local SDKs are **not** auto-updated. No
   change is in scope. Note for the sample/req-1 context: the sample's auto-update demo installs an
   old, fully-specified *runtime* and watches it get bumped; the local-SDK sample commands added below
   use the same fully-specified-passthrough mechanism to install a *pinned* SDK, but that SDK will
   **not** auto-update. If we ever want local SDKs to auto-update too, that is a separate, larger
   change (drop the `!== 'sdk'` filter and validate SDK feature-band update semantics) and should be
   its own proposal — flag it, don't silently expand scope here.

8. **`acquireStatus` is already mode-correct.** It defaults `mode`/`architecture`/`installType`/
   `requestingExtensionId`, resolves the version with `getFullVersion(version, mode)`, and calls
   `worker.acquireStatus(workerContext, commandContext.mode)`. No functional change required for SDK;
   only add test coverage (see the tests commit below).

9. **Modal child events for local SDK are currently dropped.** `ModalEventRepublisher` maps
   `sdk` + `local` to `null` for `Started`, `TotalSuccess`, `FinalError`, and `Requested`
   (only `sdk` + `global` produces `DotnetGlobalSDK*` events). We add the local-SDK equivalents.

10. **`IDotnetAcquireContext.version` docs are now inaccurate.** The current doc-comment in
    [vscode-dotnet-runtime-library/src/IDotnetAcquireContext.ts](vscode-dotnet-runtime-library/src/IDotnetAcquireContext.ts)
    says `version` is "The major.minor version of the SDK or Runtime desired" and that the richer
    formats (major / feature band / fully-specified) are available "For global SDK installations." With
    local SDK now accepting **major.minor and fully-specified**, the contract differs per
    `mode` + `installType` and must be documented on the type itself (the maintainer asked for this).
    The accepted-format matrix to encode:
    - local runtime / aspnetcore: `major.minor` (fully-specified accepted as an unsupported testing
      passthrough).
    - local sdk: `major.minor` **or** fully-specified (e.g. `8.0.408`); **not** major-only or feature
      band.
    - global sdk: major, major.minor, feature band, fully-specified.
    This is a doc-comment change only (no type-shape change); update it in the same commit that adds the
    SDK validation so code and contract land together.

### 0.4 Audit — what currently depends on the `sdk`+`local` gap (breaking-change check)

The maintainer asked whether anything relies on `sdk` being dropped today. Findings:

- **(a) The runtime _extension command_ path.** `dotnet.acquire {mode:'sdk'}` is reachable today but
  produces the inconsistent install described in 0.1 (SDK binary, runtime install-id, shared dir). It
  is incoherent and undocumented, so correcting it is a strict improvement; no event/telemetry
  consumer keys on the broken shape. Treat the new behavior as a bug fix, not a contract break.
- **(b) `getInstallCommand` reads `acquisitionContext.mode`, not `install.installMode`** (0.2). After
  the fix these agree; call it out for reviewers since it is the subtle reason today's behavior even
  produces an SDK binary.
- **(c) BREAKING TEST: the worker unit test encodes the shared-root SDK layout.** In
  [vscode-dotnet-runtime-library/src/test/unit/DotnetCoreAcquisitionWorker.test.ts](vscode-dotnet-runtime-library/src/test/unit/DotnetCoreAcquisitionWorker.test.ts),
  `getExpectedPath(installId, 'sdk')` returns `<.dotnet>/dotnet(.exe)` with the `installId` **dropped** —
  i.e. it asserts the old shared-root behavior. The per-install-folder fix (Commit 1A) changes the real
  provider, so this helper **must** be updated to `<.dotnet>/<installId>/dotnet(.exe)`. The existing
  local-SDK worker tests that flow through it — `acquireWithVersion('5.0','sdk')`,
  `acquireStatus('5.0','sdk','local')`, `acquireAndUninstallAll('6.0','sdk','local')`,
  `repeatAcquisition('5.0','sdk')`, and the SDK timeout test — will otherwise fail. This is the concrete
  instance of "a test relies on 'sdk' being dropped." (These same tests are good news too: the worker
  local-SDK path is already covered; the migration only adds extension-command + isolation + id-marker
  coverage.)
- **(d) No dedicated `ModalEventRepublisher` unit test exists**, so nothing asserts `sdk`+`local` →
  `null`. Adding the local-SDK events (Commit 3) is purely additive and ships a *new* test.
- **(e) `installRuntime` test helper is a misnomer:** it already takes and respects `mode`. Rename to
  `installLocal` when adding SDK coverage (mechanical; ~all call sites are `'runtime'`/`'aspnetcore'`).

---

## Commit 1 — Make local SDK installs self-isolating and self-describing (library)

**Goal:** before any acquire wiring, fix two install-identity problems in the library so a local SDK is
isolated and unambiguously identified: (A) give each local SDK its own folder, and (B) tag its
install-id with `~sdk`. Both **must land before** the acquire wiring (next commit); otherwise
`uninstallLocal` of a local SDK would wipe every runtime + SDK under `.dotnet` (see finding 6) and the
id would remain ambiguous with a local runtime (finding 5).

### Part A — Per-install folder for local SDK

**File:** [vscode-dotnet-runtime-library/src/Acquisition/SdkInstallationDirectoryProvider.ts](vscode-dotnet-runtime-library/src/Acquisition/SdkInstallationDirectoryProvider.ts)

```ts
import * as path from 'path';
import { IInstallationDirectoryProvider } from './IInstallationDirectoryProvider';

export class SdkInstallationDirectoryProvider extends IInstallationDirectoryProvider
{
    public getInstallDir(installId: string): string
    {
        // One folder per install (== its own DOTNET_ROOT), mirroring RuntimeInstallationDirectoryProvider.
        // A shared root would let `dotnet` pick up sibling SDK versions and would make uninstalling one
        // SDK wipe every other install (SDKs and runtimes) under `.dotnet`.
        return path.join(this.getStoragePath(), installId);
    }
}
```

**Why this is safe for the shipping global SDK path**
- Global SDK installs are placed and located via `WinMac/LinuxGlobalInstaller.getExpectedGlobalSDKPath`
  (a system location), never via `getInstallDir`. `getSimilarExistingInstall` also branches on
  `isGlobal` and uses `getExpectedGlobalSDKPath` for global.
- Install **records** live in `extensionState` under the constant key `'installed'`, and their mutex is
  the constant `'installedLk'` (`getLockFilePathForKeySimple`) — both independent of `getInstallDir`.
  Existing tracked installs are not moved or invalidated.
- Global uninstall uses `installHasNoRegisteredDependentsBesidesId` (record-based), not the
  `getInstallDir`-derived live-exe path. The only global caller of a `getInstallDir`-derived path is a
  live-dependent PATH/DOTNET_ROOT check that never matched the real system location anyway, so its
  result is unchanged in practice.

**Behavior change (local SDK only):** a local SDK now lands at `<.dotnet>/<installId>/` instead of the
bare `<.dotnet>` root (and instead of the old extension's `%APPDATA%\.dotnet` / `~/.vscode-dotnet-sdk/.dotnet`).
Document in the changelog (Docs commit).

### Part B — `~sdk` install-id marker for local SDK

**File:** [vscode-dotnet-runtime-library/src/Utils/InstallIdUtilities.ts](vscode-dotnet-runtime-library/src/Utils/InstallIdUtilities.ts)
(`getInstallIdCustomArchitecture`).

Make the id self-describing for local SDK, mirroring `~aspnetcore`, **without touching global ids**
(see finding 5 for why global must not change):

```ts
// local only: runtime => '', sdk => '~sdk', aspnetcore => '~aspnetcore'
// Global SDK keeps its historical `${version}-global~${arch}` id on purpose: re-tagging it would
// orphan existing global-SDK records and force an elevated reinstall (UAC) on the next acquire.
const localModeSuffix = mode === 'aspnetcore' ? '~aspnetcore' : mode === 'sdk' ? '~sdk' : '';

return installType === 'global'
    ? `${version}-global~${architecture}${mode === 'aspnetcore' ? '~aspnetcore' : ''}`
    : `${version}~${architecture}${localModeSuffix}`;
```

**No other parsing changes are required** (verified): `isRuntimeInstallId` already treats `'sdk'` as a
non-runtime marker via `DOTNET_INSTALL_MODE_LIST`; `getVersionFromLegacyInstallId` /
`getArchFromLegacyInstallId` read segments `[0]`/`[1]` so the trailing `~sdk` (segment `[2]`) is inert;
legacy-only helpers (`getAssumedInstallInfo`, `existingLegacyInstalls`, `removeMatchingLegacyInstall`)
only handle bare ids without `~`. Add a short comment on `getInstallIdCustomArchitecture` recording the
"local SDK is `~sdk`, global SDK intentionally unmarked" rule.

**Tests**
- Add `getInstallIdCustomArchitecture` unit cases: local sdk → `8.0.408~<arch>~sdk`; global sdk →
  `8.0.408-global~<arch>` (unchanged); local runtime → `8.0.5~<arch>` (unchanged); confirm
  `isRuntimeInstallId` returns `false` for the local-sdk id and `true` for the runtime id.

**Tests (Part A)**
- Add a library unit test asserting `new SdkInstallationDirectoryProvider(p).getInstallDir('8.0.408~x64~sdk')`
  ends with `.dotnet/8.0.408~x64~sdk` and differs per install id.
- **Update the existing worker test that encodes the old shared-root layout** (audit 0.4c): in
  [vscode-dotnet-runtime-library/src/test/unit/DotnetCoreAcquisitionWorker.test.ts](vscode-dotnet-runtime-library/src/test/unit/DotnetCoreAcquisitionWorker.test.ts),
  change `getExpectedPath(installId, 'sdk')` from `path.join(dotnetFolderName, getDotnetExecutable())`
  to `path.join(dotnetFolderName, installId, getDotnetExecutable())` so the existing local-SDK worker
  tests (`acquireWithVersion`/`acquireStatus`/`acquireAndUninstallAll`/`repeatAcquisition` with `'sdk'`)
  assert the new per-install folder. Without this, Commit 1A fails those tests.
- End-to-end isolation is covered by the "uninstall one local SDK leaves runtimes intact" test in the
  tests commit.

**Verify:** `cd vscode-dotnet-runtime-library && npm run compile && npm run test`.

---

## Commit 2 — Make `dotnet.acquire` install a local SDK

**Goal:** `dotnet.acquire` with `mode: 'sdk'` (and not global) installs a local SDK; global is
rejected; SDK versions resolve correctly.

**File:** [vscode-dotnet-runtime-extension/src/extension.ts](vscode-dotnet-runtime-extension/src/extension.ts)
(`acquireLocal`).

1. After `const mode = commandContext.mode;`, reject global early (inside `callWithErrorHandling` so
   it routes through the normal error/telemetry path):
   ```ts
   if (commandContext.installType === 'global')
   {
       throw new EventCancellationError('BadContextualInstallTypeError',
           `dotnet.acquire only performs local (user-folder) installs. For a system-wide SDK, call dotnet.acquireGlobalSDK instead.`);
   }
   ```
   (`EventCancellationError` is already imported and used here.)

2. Rename the misleadingly-named resolver and otherwise **leave the version-resolution block as-is** —
   the existing mode-agnostic logic already does the right thing for SDK (major.minor resolves; a
   3-part value passes through to the install script for pinning/testing; major-only is rejected by
   `validateVersionInput`). No SDK-specific branch or guard (per finding 1, requirement 1):
   ```ts
   // Works for runtime, aspnetcore, AND sdk. `>2` parts == fully specified => passthrough
   // (also auto-sets forceUpdate below), else resolve major.minor to the latest patch for `mode`.
   const versionResolver = new VersionResolver(workerContext);
   commandContext.version = commandContext.version.split('.')?.length > 2
       ? commandContext.version
       : await versionResolver.getFullVersion(commandContext.version, mode);
   ```
   (The pre-existing `version.split('.').length > 2 && forceUpdate === undefined => forceUpdate = true`
   block above this is also mode-agnostic, so a pinned 3-part SDK installs the exact version requested,
   just like runtime.)

3. Replace the dispatch ternary with a `switch` (per the user's request) and add the SDK branch:
   ```ts
   const acquisitionInvoker = new AcquisitionInvoker(workerContext, utilContext);
   switch (mode)
   {
       case 'sdk':
           return worker.acquireLocalSDK(workerContext, acquisitionInvoker);
       case 'aspnetcore':
           return worker.acquireLocalASPNET(workerContext, acquisitionInvoker);
       case 'runtime':
       default:
           return worker.acquireLocalRuntime(workerContext, acquisitionInvoker);
   }
   ```

4. **Do not** add `setPathEnvVar`. **Do not** add a `knownExtensionIds` check.

**Notes**
- The post-acquire `getInstallIdCustomArchitecture(...mode, 'local')` + `DotnetAcquisitionTotalSuccessEvent`
  block is already generic; no change.
- `getExistingInstallOffline` / `getSimilarExistingInstall` are mode-aware (compare `installMode`), so
  the offline pre-check already discriminates SDK vs runtime.

**Verify**
- `cd vscode-dotnet-runtime-extension && npm run compile`.
- Manual: `dotnet.acquire { version: '8.0', mode: 'sdk', requestingExtensionId }` installs an SDK
  under `<globalStoragePath>/.dotnet/<installId>` (its own folder, per Commit 1); PATH is unchanged.
- Manual: `dotnet.acquire { version: '8.0.408', mode: 'sdk' }` pins and installs that exact SDK patch
  (passthrough).
- `dotnet.acquire { version: '8.0', mode: 'sdk', installType: 'global' }` rejects with the new message.
- `dotnet.acquire { version: '8', mode: 'sdk' }` rejects (major-only; `validateVersionInput`). A
  feature band like `{ version: '8.0.4xx', mode: 'sdk' }` is accepted by the resolver-bypass but then
  fails at the install script — document as global-only (add both as tests in the tests commit).

---

## Commit 3 — Add Local SDK modal child events + telemetry republishing

**Goal:** emit `DotnetLocalSDKAcquisition*` child events (parallel to the existing `DotnetGlobalSDK*`
and `DotnetRuntime*` families), including the requested `LocalSDKAcquisitionTotalSuccess`.

**File:** [vscode-dotnet-runtime-library/src/EventStream/EventStreamEvents.ts](vscode-dotnet-runtime-library/src/EventStream/EventStreamEvents.ts)

Add four classes next to their existing siblings, reusing the existing base classes:

```ts
// next to DotnetGlobalSDKAcquisitionStarted (extends DotnetAcquisitionStartedBase)
export class DotnetLocalSDKAcquisitionStarted extends DotnetAcquisitionStartedBase
{
    public readonly eventName = 'DotnetLocalSDKAcquisitionStarted';
    public readonly type = EventType.DotnetModalChildEvent;
}

// next to DotnetGlobalSDKAcquisitionTotalSuccessEvent (extends DotnetAcquisitionTotalSuccessEventBase)
export class DotnetLocalSDKAcquisitionTotalSuccessEvent extends DotnetAcquisitionTotalSuccessEventBase
{
    public readonly eventName = 'DotnetLocalSDKAcquisitionTotalSuccessEvent';
}

// next to DotnetGlobalSDKAcquisitionError (extends DotnetAcquisitionFinalErrorBase)
export class DotnetLocalSDKAcquisitionError extends DotnetAcquisitionFinalErrorBase
{
    public eventName = 'DotnetLocalSDKAcquisitionError';
    public verboseOutputOnly = true;
}

// next to DotnetGlobalSDKAcquisitionRequested (extends DotnetAcquisitionRequestedEventBase)
export class DotnetLocalSDKAcquisitionRequested extends DotnetAcquisitionRequestedEventBase
{
    public readonly eventName = 'DotnetLocalSDKAcquisitionRequested';
}
```

**File:** [vscode-dotnet-runtime-library/src/EventStream/ModalEventPublisher.ts](vscode-dotnet-runtime-library/src/EventStream/ModalEventPublisher.ts)
(class `ModalEventRepublisher`)

Update the four `case 'sdk':` arms to emit the local variant instead of `null`:

```ts
// DotnetAcquisitionStarted
case 'sdk':
    return event.installType === 'global'
        ? new DotnetGlobalSDKAcquisitionStarted(event.requestingExtensionId)
        : new DotnetLocalSDKAcquisitionStarted(event.requestingExtensionId);

// DotnetAcquisitionTotalSuccessEvent
case 'sdk':
    return event.installType === 'global'
        ? new DotnetGlobalSDKAcquisitionTotalSuccessEvent(event.install)
        : new DotnetLocalSDKAcquisitionTotalSuccessEvent(event.install);

// DotnetAcquisitionFinalError
case 'sdk':
    return event.installType === 'global'
        ? new DotnetGlobalSDKAcquisitionError(event.error, event.originalEventName, event.install)
        : new DotnetLocalSDKAcquisitionError(event.error, event.originalEventName, event.install);

// DotnetAcquisitionRequested
case 'sdk':
    return event.installType === 'global'
        ? new DotnetGlobalSDKAcquisitionRequested(event.startingVersion, event.requestingId, event.mode)
        : new DotnetLocalSDKAcquisitionRequested(event.startingVersion, event.requestingId, event.mode);
```

Add the four new imports to the `ModalEventPublisher.ts` import block.

**Exports / barrels**
- Add the four classes wherever the `DotnetGlobalSDK*` siblings are re-exported (library
  `index.ts` / `EventStreamEvents` barrel) so the extension and tests can import them.
- `grep` for `DotnetGlobalSDKAcquisitionTotalSuccessEvent` to find every export site and mirror it.

**Optional cleanup**
- `DotnetSDKAcquisitionStarted` (the old non-modal event the SDK extension posted manually) becomes
  unused after the extension is deleted. Leave it for now (harmless) or remove in the final cleanup
  commit; do not remove anything still referenced by the library.

**Tests:** add a **new** republisher unit test (none exists today — audit 0.4d) asserting that
`sdk` + `local` now produces the four new events and `sdk` + `global` still produces the global ones.

**Verify:** `cd vscode-dotnet-runtime-library && npm run compile && npm run test`.

---

## Commit 4 — Confirm/secure `acquireStatus` for local SDK

**Goal:** guarantee `dotnet.acquireStatus { mode: 'sdk' }` reports local SDK status correctly.

**Findings:** `dotnet.acquireStatus` already passes `commandContext.mode` to both the version resolver
and `worker.acquireStatus`. The worker builds the install via `GetDotnetInstallInfo(version, installMode,
'local', arch)` and uses the context's (mode-correct) directory provider. **No functional change is
expected.**

**Action:**
- Re-read `dotnetAcquireStatusRegistration` and confirm there is no hard-coded `'runtime'` and no
  runtime-only resolver. If a latent runtime assumption is found (e.g. a `looksLikeRuntimeVersion`
  branch on the status path), fix it minimally here.
- Otherwise this "commit" is just the test added in the tests commit (Commit 5); fold it in if there
  is no code change.

---

## Commit 5 — Migrate tests from the SDK extension

**Source:** [vscode-dotnet-sdk-extension/src/test/functional/DotnetCoreAcquisitionExtension.test.ts](vscode-dotnet-sdk-extension/src/test/functional/DotnetCoreAcquisitionExtension.test.ts)
**Target:** [vscode-dotnet-runtime-extension/src/test/functional/DotnetCoreAcquisitionExtension.test.ts](vscode-dotnet-runtime-extension/src/test/functional/DotnetCoreAcquisitionExtension.test.ts)

Disposition of each SDK-extension test:

| SDK-extension test | Action |
| --- | --- |
| `Activate` | **Drop** — already covered by the runtime extension's `Activate`. |
| `Install Command with Unknown Extension Id` | **Remove** — the `knownExtensionIds` gate is gone. |
| `Global Install Version Parsing Handles Different Version Formats…` | **Move, don't duplicate.** This is really a `GlobalInstallerResolver` test. Confirm via `grep` it is not already covered; if not, relocate it (preferably as a library unit test under `vscode-dotnet-runtime-library/src/test/unit`, since it constructs `GlobalInstallerResolver` with a mock web worker and asserts on `getFullySpecifiedVersion`/`getInstallerUrl`). It needs `src/test/mocks/mock-releases.json` — reuse the runtime library's existing mock if equivalent, otherwise move the mock too. |
| `Install Status Command` (local SDK acquire → status → uninstall) | **Migrate** as the key local-SDK e2e test (see below). |

New local-SDK e2e test in the runtime extension (model it on the existing `testAcquire` /
`Install Runtime Status Command`, and keep the SDK extension's PATH guard so it does not run on a box
with a global SDK on PATH):

```ts
test('Install Local SDK Status Command', async () =>
{
    if (process.env.PATH?.includes('dotnet'))
    {
        warn('Skipping local SDK test: a global dotnet is on PATH.');
        return;
    }
    const context: IDotnetAcquireContext = { version: '8.0', requestingExtensionId, mode: 'sdk' };

    let result = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquireStatus', context);
    assert.notExists(result);

    result = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', context);
    assert.exists(result);
    assert.isTrue(fs.existsSync(result!.dotnetPath!));

    result = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquireStatus', context);
    assert.exists(result);

    // PATH must NOT have been modified for a local SDK install.
    // (assert against the extension's MockEnvironmentVariableCollection / process.env as appropriate)

    await vscode.commands.executeCommand('dotnet.uninstallAll');
}).timeout(standardTimeoutTime);
```

Add a focused negative test for the new guard:

```ts
test('Local acquire rejects global SDK requests', async () =>
{
    const context: IDotnetAcquireContext = { version: '8.0', requestingExtensionId, mode: 'sdk', installType: 'global' };
    return assert.isRejected(vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', context));
}).timeout(standardTimeoutTime);
```

Add version-format tests reflecting requirement 1 (major.minor resolves; fully-specified passes
through; major-only is rejected):

```ts
test('Local SDK acquire installs a fully-specified (pinned) version via passthrough', async () =>
{
    // 3-part value bypasses resolution and installs that exact SDK (same mechanism as runtime).
    const context: IDotnetAcquireContext = { version: '8.0.408', requestingExtensionId, mode: 'sdk' };
    const result = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', context);
    assert.exists(result!.dotnetPath);
    assert.include(result!.dotnetPath, '8.0.408', 'The pinned SDK patch is installed');
}).timeout(standardTimeoutTime);

test('Local SDK acquire rejects a major-only version', async () =>
{
    // Major-only is a dotnet.acquireGlobalSDK capability; locally it fails version validation.
    const context: IDotnetAcquireContext = { version: '8', requestingExtensionId, mode: 'sdk' };
    return assert.isRejected(vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', context));
}).timeout(standardTimeoutTime);
```

Add an isolation regression test that guards the Commit 1 directory-provider fix (this is the test
that would have caught the shared-folder data-loss bug):

```ts
test('Uninstalling a local SDK leaves local runtimes intact', async () =>
{
    // Arrange: install a local runtime and a local SDK.
    await installLocal('8.0', 'runtime');
    const sdkContext: IDotnetAcquireContext = { version: '8.0', requestingExtensionId, mode: 'sdk' };
    const sdk = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', sdkContext);

    // Act: uninstall just the local SDK.
    await vscode.commands.executeCommand('dotnet.uninstall', sdkContext);

    // Assert: the runtime install still exists on disk (it must NOT share the SDK's folder).
    const runtimeStatus = await vscode.commands.executeCommand<IDotnetAcquireResult>(
        'dotnet.acquireStatus', { version: '8.0', requestingExtensionId, mode: 'runtime' });
    assert.exists(runtimeStatus, 'Uninstalling a local SDK must not remove a local runtime.');
}).timeout(standardTimeoutTime);
```

Add local-SDK uninstall coverage (requirement 3). The existing `installUninstallOne` /
`installUninstallAll` helpers already take `mode` + `installType`, so these are one-liners that also
exercise the per-install-folder isolation from Commit 1A:

```ts
test('Uninstall One Local SDK Command', async () =>
{
    // Installs two SDK minor versions, uninstalls one, asserts the other survives
    // (only possible because each local SDK now has its own folder).
    await installUninstallOne('8.0', '9.0', 'sdk', 'local');
}).timeout(standardTimeoutTime);

test('Uninstall All Local SDK Command', async () =>
{
    await installUninstallAll('8.0', 'sdk');
}).timeout(standardTimeoutTime);
```

Use the existing helpers/constants in the runtime test file (`requestingExtensionId = 'fake.extension'`,
`standardTimeoutTime`, `warn`; `DotnetInstallMode` is already imported). Per audit 0.4e, **rename the
`installRuntime` helper to `installLocal`** (it already takes and respects `mode`) and update its call
sites — a mechanical rename that makes the SDK tests read correctly. The `installUninstallOne`,
`installUninstallAll`, and `uninstallWithMultipleOwners` helpers are already mode-generic, so no new
helpers are needed for SDK.

**Verify:** `./test.sh rnt` (or `test.ps1` on Windows) and the library unit run for the moved resolver
test. Tests run against compiled JS — `npm run compile` first.

---

## Commit 6 — Sample extension: local SDK demo commands

The sample is how the local-SDK path is exercised by hand. Add commands that mirror the existing
runtime samples but pass `mode: 'sdk'`. These are **new** commands calling the new `dotnet.*` API (not
the deleted `dotnet-sdk.*` extension, whose `sample.dotnet-sdk.*` commands are removed in Commit 8).

**File:** [sample/src/extension.ts](sample/src/extension.ts)

- `sample.dotnet.acquireSDK` → reuse the existing `callAcquireAPI(version, 'sdk')` helper (it already
  posts `forceUpdate: true`, so a fully-specified version pins that exact SDK — the requirement-1
  passthrough that lets you install a specific older SDK by hand).
- `sample.dotnet.acquireSDKStatus` → `dotnet.acquireStatus` with `{ version, requestingExtensionId,
  mode: 'sdk' }`. NOTE: the existing runtime status sample omits `mode` (defaults to runtime); the SDK
  variant **must** pass `mode: 'sdk'` or it will check for a runtime instead.
- `sample.dotnet.uninstallSDK` → `dotnet.uninstall` with `{ version, requestingExtensionId,
  mode: 'sdk' }` (single-version uninstall).
- `sample.dotnet.uninstallAllSDK` → `dotnet.uninstallAll`. Call out in the title that `uninstallAll`
  is **mode-agnostic** (it wipes every VS Code-managed install, runtime and SDK alike); there is no
  SDK-only "uninstall all". This exists for parity/discoverability.

Register each in [sample/package.json](sample/package.json) under `contributes.commands` (mirroring the
existing `sample.dotnet.*` entries) so they appear in the command palette.

**Auto-update (finding 7):** local SDKs are not auto-updated, so do **not** add an SDK analogue of the
runtime auto-update / `concurrentTest` demo. A pinned-then-update SDK demo would require the separate
auto-update scope change.

**Verify:** launch the Sample Extension; run `sample.dotnet.acquireSDK` (try `8.0` and a pinned
`8.0.408`), then `sample.dotnet.acquireSDKStatus`, `sample.dotnet.uninstallSDK`; confirm a local
runtime installed alongside survives the SDK uninstall.

---

## Commit 7 — Docs + changelog (breaking change)

1. **[Documentation/commands.md](Documentation/commands.md) → `dotnet.acquire`:** document that `mode`
   may be `'runtime'` (default), `'aspnetcore'`, or `'sdk'`; that `mode: 'sdk'` performs a **local,
   user-folder SDK install**; that **PATH is not configured** for local SDK installs (the caller gets
   the path back via `IDotnetAcquireResult.dotnetPath` and is responsible for using it); that global
   SDK installs must use `dotnet.acquireGlobalSDK`; and that local SDKs are **not auto-updated**.
   Add an explicit **accepted version formats** table so the runtime/local-SDK/global-SDK differences
   are unambiguous (this is the user-facing clarity the maintainer asked for):

   | Command (mode) | `major` (`8`) | `major.minor` (`8.0`) | feature band (`8.0.4xx`) | fully specified (`8.0.404`) |
   | --- | :---: | :---: | :---: | :---: |
   | `dotnet.acquire` runtime / aspnetcore | ❌ | ✅ | ❌ | ⚠️ testing-only passthrough |
   | `dotnet.acquire` **sdk (local)** | ❌ | ✅ | ❌ | ⚠️ testing-only passthrough |
   | `dotnet.acquireGlobalSDK` (sdk, global) | ✅ | ✅ | ✅ | ✅ |

   - Under `dotnet.acquire`, explicitly state: **local SDK officially supports `major.minor`** (e.g.
     `8.0`, resolved to the latest patch) and additionally accepts a **fully-specified patch as an
     unsupported testing/pinning passthrough** (e.g. `8.0.408`). **Major-only and feature band
     (`8.0.4xx`) are not supported locally** — use `dotnet.acquireGlobalSDK` for those (a feature band
     passed locally is not understood by the install script and fails). This mirrors the runtime path.
   - Under `dotnet.acquireGlobalSDK`, the four-format list already exists; cross-link it from the
     `dotnet.acquire` SDK note so readers see where richer formats are supported.
   - For runtime, clarify the existing reality: `major.minor` is the supported format; a
     fully-specified version is accepted as an **unsupported testing affordance** (passed through
     without resolution), and `major`-only / feature-band are not accepted.
2. **[vscode-dotnet-runtime-extension/CHANGELOG.md](vscode-dotnet-runtime-extension/CHANGELOG.md):**
   add a **Breaking change** entry:
   - The standalone `vscode-dotnet-sdk` extension (`ms-dotnettools.vscode-dotnet-sdk`, unshipped for
     1+ year) is removed.
   - Consumers that previously called `dotnet-sdk.acquire` for a local SDK must call
     `dotnet.acquire` with `{ mode: 'sdk' }`. `dotnet-sdk.*` commands no longer exist.
   - Local SDK acquisition via `dotnet.acquire` accepts **`major.minor`** (e.g. `8.0`, resolved to the
     latest patch) and a **fully-specified patch** (e.g. `8.0.408`) as a testing/pinning passthrough,
     mirroring the runtime path. **Major-only and feature-band** formats remain a
     `dotnet.acquireGlobalSDK`-only capability.
   - Local SDKs now install under the VS Code-managed global-storage `.dotnet` folder in **one
     isolated subfolder per SDK version** (`<globalStorage>/.dotnet/<installId>/`). Previously every
     local SDK shared a single `%APPDATA%\.dotnet` / `~/.vscode-dotnet-sdk/.dotnet` folder. Old
     SDK-extension installs are orphaned (harmless) and may be removed manually.
   - Only bump the extension version (`npm version patch`) **if explicitly requested** (per repo
     instructions).
3. Update prose references that describe "two extensions":
   [README.md](README.md), [.github/copilot-instructions.md](.github/copilot-instructions.md),
   [Documentation/contributing-workflow.md](Documentation/contributing-workflow.md),
   [Documentation/global-installs/global-devkit-adoption-plan.md](Documentation/global-installs/global-devkit-adoption-plan.md).
4. Remove SDK-only docs that no longer apply:
   [Documentation/troubleshooting-sdk.md](Documentation/troubleshooting-sdk.md) (and any links to it),
   and the `dotnet-sdk.recommendedVersion` sample reference in `commands.md`.

---

## Commit 8 — Delete the SDK extension and all of its build wiring

Do this **last**, after tests are migrated, so coverage is never lost. Group as one commit (or split
"delete folder" vs "remove wiring" if the diff is large).

**Delete the project**
- Remove the entire [vscode-dotnet-sdk-extension/](vscode-dotnet-sdk-extension) folder (includes
  `src/extension.ts`, `src/ExtensionUninstall.ts`, `src/DotnetCoreAcquisitionId.ts`
  (`ms-dotnettools.vscode-dotnet-sdk`), `src/test/**`, `package.json`, `webpack.config.js`,
  `CHANGELOG.md`, `README.md`, etc.).

**Build scripts**
- [build.ps1](build.ps1): remove the "Compile SDK extension" `pushd vscode-dotnet-sdk-extension … popd`
  block.
- [build.sh](build.sh): remove the matching "Compiling vscode-dotnet-sdk-extension" block.
- [test.ps1](test.ps1): remove the `vscode-dotnet-sdk-extension` test block (and any `-ne 'sdk'`
  selector logic).
- [test.sh](test.sh): remove the "Testing vscode-dotnet-sdk-extension" block (and selector logic).

**Pipelines**
- [pipeline-templates/build-test.yaml](pipeline-templates/build-test.yaml): remove the
  `vscode-dotnet-sdk-extension/dist/test/functional/logs` artifact path.
- [pipeline-templates/package-vsix.yaml](pipeline-templates/package-vsix.yaml): remove the
  `is-sdk-release` / `package-name = 'vscode-dotnet-sdk'` branch; the matrix is already runtime-only,
  so simplify the version `bash` step accordingly.
- [release.yml](release.yml): confirm it is runtime-only (it publishes
  `vscode-dotnet-runtime-extension`); remove any lingering SDK references if found.
- Scan `1es-azure-pipeline.yml`, `1pr-azure-pipeline.yml`, `es-metadata.yml`, and the other
  `pipeline-templates/*.yaml` for `sdk` references and clean up.

**Workspace / editor config**
- [.vscode/settings.json](.vscode/settings.json): remove `./vscode-dotnet-sdk-extension` from
  `eslint.workingDirectories`.
- [vscode-dotnet-runtime.code-workspace](vscode-dotnet-runtime.code-workspace): remove the
  `vscode-dotnet-sdk-extension` folder entry.
- [.gitignore](.gitignore): remove `vscode-dotnet-sdk-extension/LICENSE.txt`.

**Sample extension** (it depends on the deleted extension)
- [sample/package.json](sample/package.json): remove the `"vscode-dotnet-sdk":
  "file:../vscode-dotnet-sdk-extension"` dependency and the six `sample.dotnet-sdk.*` command
  contributions.
- [sample/src/extension.ts](sample/src/extension.ts): remove the old "sdk extension registrations"
  block (`sampleSDK*`, ~lines 365–495) that called the deleted `dotnet-sdk.*` commands. The replacement
  `sample.dotnet.*SDK` local-SDK demo commands were already added in Commit 6; keep the existing
  `dotnet.acquireGlobalSDK` sample for global.
- Regenerate `sample/package-lock.json` and `sample/yarn.lock` (remove `vscode-dotnet-sdk` entries) by
  running the repo's install flow rather than hand-editing.

**Root / misc**
- [package.json](package.json) (root): remove `vscode-dotnet-sdk-extension` from any workspaces/scripts
  if present.
- [dependency-verifier.py](dependency-verifier.py), [PoliCheckExclusions.xml](PoliCheckExclusions.xml):
  `grep` for `sdk-extension` / `vscode-dotnet-sdk` and remove stale entries.
- `.github/copilot-instructions.md`: update the architecture/section list and any `cd
  vscode-dotnet-sdk-extension` references.

**Final repo-wide sweep**
- `grep -ri "vscode-dotnet-sdk" .` and `grep -ri "dotnet-sdk\." .` and confirm only intentional
  references remain (e.g. historical changelog notes). Nothing should still build, test, package, or
  import the SDK extension.

**Verify:** full `./build.sh` (or `build.cmd`) and `./test.sh --eslint` succeed with the SDK extension
gone.

---

## Suggested commit order (review-friendly)

1. **Commit 1** — Library install-identity fixes for local SDK: per-install folder
   (`SdkInstallationDirectoryProvider`) **and** `~sdk` install-id marker
   (`getInstallIdCustomArchitecture`), plus the worker-test `getExpectedPath('sdk')` update; with unit
   tests. Prerequisite safety/correctness fix; must precede the acquire wiring.
2. **Commit 2** — `dotnet.acquire` local SDK dispatch (switch + `acquireLocalSDK`), 3-part passthrough
   parity, and global rejection (feature is testable immediately).
3. **Commit 3** — Local SDK modal events + republisher + new unit test.
4. **Commit 4** — `acquireStatus` confirmation/fix (may fold into Commit 5 if no code change).
5. **Commit 5** — Migrate/relocate tests; remove the unknown-extension-id test; add SDK status,
   passthrough, uninstall-one/all, and isolation tests; rename `installRuntime`→`installLocal`.
6. **Commit 6** — Sample extension local SDK demo commands (acquire / status / uninstall / uninstallAll).
7. **Commit 7** — Docs + changelog (breaking change).
8. **Commit 8** — Delete the SDK extension and all build/sample/pipeline wiring.

Rationale: land the folder-isolation safety fix first, then ship the capability and its tests before
deleting the old extension, so the local-SDK path is proven before its only prior home is removed.

---

## Risk register / things to watch

- **Local SDK install-id marker (Commit 1B).** Local SDK ids gain a `~sdk` suffix
  (`${version}~${arch}~sdk`) so `IsEquivalentInstallation` (id `===`) is unambiguous vs local runtime,
  rather than relying on disjoint version spaces. **Global** SDK ids are deliberately left unchanged:
  re-tagging them would orphan existing global-SDK records and trigger an elevated reinstall (UAC) on
  the next acquire. Runtime ids are untouched (no runtime orphaning), and the runtime extension has no
  pre-existing local-SDK records to orphan (the dead SDK extension used a separate `globalState`).
  Only `getInstallIdCustomArchitecture` changes; all id *parsing* already tolerates the marker.
- **Per-install SDK folders (Commit 1).** `SdkInstallationDirectoryProvider` now returns a per-id
  folder instead of the shared `.dotnet` root. This is the safety-critical change: it isolates each
  local SDK (its own `DOTNET_ROOT`, its own uninstall/lock scope) and prevents a local-SDK uninstall
  from wiping sibling SDKs and local runtimes. Verified safe for the shipping **global** SDK path
  (paths via `getExpectedGlobalSDKPath`; records/locks via constant keys). Re-run the existing global
  SDK acquisition/uninstall tests to confirm no regression, and confirm `uninstallAll` / `resetData`
  still wipe the whole `.dotnet` root (they operate on the storage path + tracked records, both
  unaffected).
- **Offline SDK resolution.** The pre-resolution offline existing-install check covers the common
  case; a *first-ever* offline SDK install with no cached release metadata will fail the same way a
  runtime would. This matches prior behavior — don't add new offline handling.
- **Telemetry continuity.** Dashboards keyed on `DotnetGlobalSDKAcquisition*` are unaffected; new
  `DotnetLocalSDKAcquisition*` names appear for local SDK. Mention the new event names to whoever owns
  telemetry.
- **Existing tests encode the old shared-root SDK layout (audit 0.4c).** The worker unit test's
  `getExpectedPath('sdk')` hard-codes the shared `.dotnet` root (no `installId`); it **must** be moved
  to the per-install folder in Commit 1A, or the existing local-SDK worker tests fail. This is the one
  place where code "relied on `sdk` being dropped."
- **Local SDK version formats (requirement 1).** Mirrors runtime exactly: `major.minor` resolves to the
  latest patch, a fully-specified 3-part value passes through (pins the exact patch and auto-sets
  `forceUpdate`), major-only is rejected by `validateVersionInput`, and a feature band fails at the
  install script (global-only). No SDK-specific guard is added — it's the same code path as runtime.
- **High blast radius.** `dotnet.acquire` is the single most-used command. Keep the acquire commit
  (Commit 2) minimal and additive: a new `case 'sdk'` in the dispatch switch and a global-reject guard;
  the version-resolution block is **unchanged** (shared with runtime) — no change to the
  runtime/aspnetcore behavior.
