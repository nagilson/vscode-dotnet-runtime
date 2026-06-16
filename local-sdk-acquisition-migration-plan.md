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
       SDK; any older patch throws. **But** the acquire command never sends a fully-specified value to
       the resolver \u2014 the SDK branch (Decision below) detects it with `isFullySpecifiedVersion` and
       routes it straight to the install script \u2014 so a fully-specified patch installs fine. ✅ (handled
       before the resolver)
     The list above is the resolver in isolation. It matches what the deprecated SDK extension exposed,
     since that extension called `getFullVersion(version, 'sdk')` directly
     with **no** fully-specified handling \u2014 so the education bundle was major.minor-only. The other
     formats (major, feature band) are a **`dotnet.acquireGlobalSDK`-only** capability, because
     only `GlobalInstallerResolver` does feature-band/patch resolution against the per-channel manifest.
   - **Decision (REVISED — explicit fully-specified SDK + early, mode-aware validation):** local SDK
     officially supports **two** formats: `major.minor` (e.g. `8.0`, resolved to the latest patch) and
     **fully-specified** (e.g. `8.0.408`, installed exactly). We do **not** lean on the runtime
     `>2`-passthrough as an implicit "testing" affordance for SDK; instead we **validate the version
     shape up front** so a bad version fails immediately with a clear message rather than deep in the
     install script. Reuse the library's existing, already-tested classifiers (the same trichotomy
     `GlobalInstallerResolver.getFullySpecifiedVersion` uses) — no new parsing — wrapped in a single
     reusable helper `assertValidLocalSdkVersion(version, eventStream, context)` added to
     `VersionUtilities` (Commit 2): it throws unless the version is one of:
     - fully-specified (`isFullySpecifiedVersion`, e.g. `8.0.408`) ⇒ accept, install exactly.
     - major.minor (2 parts and `isNonSpecificMajorOrMajorMinorVersion`, e.g. `8.0`) ⇒ resolve via
       `getFullVersion(v, 'sdk')`.
     Feature band (`8.0.4xx`), bare major (`8`), or anything else ⇒ **throws early** with a message
     pointing at `dotnet.acquireGlobalSDK`. The helper only validates; the caller picks resolve-vs-use
     with one `isFullySpecifiedVersion` check.
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

7. **Auto-update currently excludes SDK — we now ADD local SDK auto-update (Commit 7).**
   `LocalInstallUpdateService.getInstallGroups` filters
   `installMode !== 'sdk' && isGlobal !== true`, so local SDKs are not auto-updated today. The
   maintainer wants parity with runtimes, so Commit 7 drops the `installMode !== 'sdk'` clause (keeping
   `isGlobal !== true`). Two things make this low-risk:
   - **The in-use matrix is already mode-agnostic.** `trackInstalledVersion` →
     `addVersionToExtensionState` calls `markInstallAsInUse(path)` on every successful acquire, and the
     live-dependent check is keyed on the **executable path**, not the mode. So an SDK that was returned
     to a consumer is already protected from the auto-update uninstall step — no change needed, just a
     test.
   - **The "latest" comparison already handles 3-part versions** (it numerically compares the third
     component after stripping any `-preview` suffix), and SDK encodes band+patch in that component
     (`8.0.412` > `8.0.305`), so it orders SDKs correctly.
   The one **semantic** call-out: resolving `group.majorMinor` (e.g. `8.0`) for SDK yields the channel's
   `latest-sdk`, which can **cross feature bands** (e.g. `8.0.3xx` → `8.0.4xx`). That is the intended
   "always latest in channel" behavior (matches runtime's "latest patch" philosophy and Microsoft's SDK
   guidance), but it is a larger jump than a runtime patch — document it. **Global SDKs stay excluded**
   (see the id-encoding discrepancy in finding 11).

8. **`acquireStatus` is already *mode*-correct (but not *version-format*-correct — see finding 12).**
   It defaults `mode`/`architecture`/`installType`/`requestingExtensionId`, resolves the version with
   `getFullVersion(version, mode)`, and calls `worker.acquireStatus(workerContext, commandContext.mode)`.
   The mode threading needs no change for SDK; the **fully-specified version handling does** (it always
   resolves, breaking pinned non-latest versions) — fixed in Commit 4 per finding 12.

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

11. **Install-id encoding is asymmetric for SDK, and the auto-update filter must use structured fields,
    not id strings.** After Commit 1B:
    - **Local** SDK ids carry the `~sdk` marker (`8.0.408~x64~sdk`) and **will** auto-update.
    - **Global** SDK ids carry `-global` and **no** `~sdk` marker (`8.0.408-global~x64`); today `-global`
      *implies* SDK because global installs are SDK-only, and these **won't** auto-update.
    So the marker is asymmetric: a `-global` id means "SDK, not auto-updated"; a `~sdk` id means "local
    SDK, auto-updated." This is safe **only because** the auto-update filter keys off the structured
    `installMode` / `isGlobal` fields, not id-string parsing — `isGlobal !== true` correctly excludes
    global SDKs regardless of the (unmarked) id. Add a comment so nobody "optimizes" the filter into
    string matching.
    - **The opposite problem if global runtime is ever added:** local ids mark the *non-default* mode
      (`sdk`/`aspnetcore`) and leave runtime unmarked; global ids currently treat *sdk* as the default
      (unmarked). So a future global **runtime** would need a `runtime` (+`-global`) marker to be
      distinguishable from a global SDK — the mirror image of the local case. Note this so whoever adds
      global-runtime support knows the id scheme has to gain a global-side mode marker (and the
      auto-update filter would then need to decide runtime-vs-sdk for global, not just `isGlobal`).

12. **`acquireStatus` and `uninstall` (local) unconditionally resolve via `getFullVersion`, so they
    cannot address a fully-specified, non-latest version — a glaring inconsistency once fully-specified
    local SDK installs exist.** Verified:
    - **`dotnetAcquireStatusRegistration`** always runs
      `commandContext.version = await getFullVersion(version, mode)` (the variable is even misnamed
      `runtimeVersionResolver`). `getFullVersion` resolves against `releases-index.json`, which only
      exposes each channel's *latest* full version + its `channelVersion` (major.minor). So a
      fully-specified request only resolves if it **equals the current latest**; any pinned older patch
      (`8.0.408` after `8.0.412` ships) **throws** `DotnetVersionResolutionError`. Worse, the offline
      pre-check it runs first (`getExistingInstallOffline` → `getSimilarExistingInstall`) matches by
      **major.minor**, so even when it doesn't throw it can return a *different* patch than requested.
      The code comment already admits this: *"acquireStatus expects only a major.minor."*
    - **`uninstall`** resolves for the normal programmatic path
      (`installType === 'local' && !force && !(onlyCheckLiveDependents && version.split('.').length > 1)`).
      The `force` branch (UI uninstall) and the `onlyCheckLiveDependents`+multipart branch (auto-update,
      which passes fully-specified versions) already **skip** resolution — that exception exists
      precisely so auto-update can uninstall fully-specified runtimes. But a plain
      `dotnet.uninstall { version: '8.0.408', mode: 'sdk' }` (force=false, onlyCheckLiveDependents=false)
      still resolves and **fails** for a non-latest patch.
    - **Net:** with explicit fully-specified SDK install support (finding 1), a caller can install
      `8.0.408` but then **cannot status-check or uninstall it by that same version string** once a newer
      patch ships. This is latent for runtime today (masked by auto-update) but becomes a guaranteed,
      user-visible gap for pinned SDKs. We fix both in Commit 4, mode-agnostically (so runtime gets the
      same robustness — no matrix expansion). The downstream `worker.acquireStatus` and
      `worker.uninstallLocal` are already **exact-install-id** based and fully offline-capable, so the
      fix lives entirely in the two extension registrations: skip resolution (and, for status, skip the
      major.minor offline pre-check) when the version is already fully-specified.

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

**Goal:** before any acquire wiring, fix the library's install-identity handling so a local SDK is
isolated and unambiguously identified: (A) give each local SDK its own folder, (B) tag its install-id
with `~sdk`, and (C) fix the `getAssumedInstallInfo` mode-precedence bug so SDK is never mislabeled as
runtime. A/B **must land before** the acquire wiring (next commit); otherwise `uninstallLocal` of a
local SDK would wipe every runtime + SDK under `.dotnet` (see finding 6) and the id would remain
ambiguous with a local runtime (finding 5). C is a one-line correctness fix in the same file as B
(finding/gap 4).

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

### Part C — Fix the `getAssumedInstallInfo` mode-precedence bug (gap 4)

**File:** [vscode-dotnet-runtime-library/src/Utils/InstallIdUtilities.ts](vscode-dotnet-runtime-library/src/Utils/InstallIdUtilities.ts)
(same file as Part B, so it lands together.)

The last line of `getAssumedInstallInfo` has an operator-precedence bug:
```ts
// BUG: `??` binds TIGHTER than `?:`, so this parses as (mode ?? isRuntimeInstallId(id)) ? 'runtime' : 'sdk'.
// => any non-null `mode` (including 'sdk' / 'aspnetcore') yields 'runtime'.
installMode: mode ?? isRuntimeInstallId(id) ? 'runtime' : 'sdk'
```
Fix with explicit parentheses to match the documented intent ("use `mode` if given, else infer from
the id"):
```ts
installMode: mode ?? (isRuntimeInstallId(id) ? 'runtime' : 'sdk')
```
- **Why now (not a follow-up):** `VersionResolver.getFullVersion` calls `getAssumedInstallInfo(version,
  context.mode)` when resolution **fails**, to attach the install to the error event. Commit 2 routes
  every accepted major.minor **SDK** request through `getFullVersion(_, 'sdk')`, so SDK resolution
  failures (offline, transient API) now flow here with `mode === 'sdk'` — and today they'd be
  mislabeled `runtime` in telemetry/error handling, exactly the attribution the rest of the plan works
  to keep correct. The fix is one line and strictly corrects behavior (it also fixes the latent
  `aspnetcore → runtime` mislabel).
- **Safety:** for `mode === null/undefined` (legacy id with no mode) the behavior is unchanged
  (`isRuntimeInstallId(id) ? 'runtime' : 'sdk'`); for `mode === 'runtime'` it's unchanged. Only the
  previously-wrong `sdk`/`aspnetcore` cases change, to their correct values.
- **Tests:** add unit cases — `getAssumedInstallInfo('8.0.408~x64~sdk', 'sdk').installMode === 'sdk'`;
  `getAssumedInstallInfo(legacyRuntimeId, undefined).installMode === 'runtime'`;
  `getAssumedInstallInfo(legacySdkId, undefined).installMode === 'sdk'`.

**Tests**
- Add `getInstallIdCustomArchitecture` unit cases: local sdk → `8.0.408~<arch>~sdk`; global sdk →
  `8.0.408-global~<arch>` (unchanged); local runtime → `8.0.5~<arch>` (unchanged); confirm
  `isRuntimeInstallId` returns `false` for the local-sdk id and `true` for the runtime id.

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

2. **Add a reusable validator `assertValidLocalSdkVersion` to**
   [vscode-dotnet-runtime-library/src/Acquisition/VersionUtilities.ts](vscode-dotnet-runtime-library/src/Acquisition/VersionUtilities.ts).
   Centralizing this keeps `acquireLocal` clean, makes the contract unit-testable in isolation, and
   gives one place to evolve the accepted-format rules. The file already imports everything needed
   (`DotnetVersionResolutionError`, `EventCancellationError`, `getInstallFromContext`, `IEventStream`,
   `IAcquisitionWorkerContext`) and already houses the classifiers, so this is local:
   ```ts
   /**
    * Throws if `version` is not an acceptable LOCAL SDK acquisition version.
    * Local SDK accepts ONLY major.minor (e.g. "8.0") or a fully-specified patch (e.g. "8.0.408").
    * Major-only ("8"), feature bands ("8.0.4xx"), and malformed versions are rejected — those are a
    * dotnet.acquireGlobalSDK capability. No-op on success.
    */
   export function assertValidLocalSdkVersion(version: string, eventStream: IEventStream, context: IAcquisitionWorkerContext): void
   {
       const parts = version.split('.').length;
       // Check segment count FIRST, then call the strict classifier only for 3-part candidates.
       // Calling isFullySpecifiedVersion on a 2-part "8.0" would post a noisy "bad long form" parse
       // event (via isValidLongFormVersionFormat) even though "8.0" is a perfectly valid request (gap 5).
       if (parts === 2 && isNonSpecificMajorOrMajorMinorVersion(version))
       {
           return; // major.minor (e.g. "8.0")
       }
       if (parts > 2)
       {
           // isFullySpecifiedVersion can THROW for some malformed 3-part inputs (e.g. "8.0.0", where the
           // SDK band/patch parse fails) — treat any throw as "not valid" so we emit the friendly message.
           try { if (isFullySpecifiedVersion(version, eventStream, context)) { return; } } catch { /* fall through */ }
       }
       const err = new DotnetVersionResolutionError(new EventCancellationError('BadContextualVersion',
           `Local .NET SDK acquisition accepts a major.minor (e.g. "8.0") or fully-specified (e.g. "8.0.408") version. ` +
           `Major-only and feature band (e.g. "8.0.4xx") versions are only supported by dotnet.acquireGlobalSDK. Got "${version}".`),
           getInstallFromContext(context));
       eventStream.post(err);
       throw err.error;
   }
   ```
   - **Segment-count-first** (gap 5): `isFullySpecifiedVersion` → `isValidLongFormVersionFormat` posts a
     "bad long form" parse event for `< 2`-period inputs, so calling it on a valid `8.0` would emit
     misleading parse telemetry. Gating it behind `parts > 2` avoids that for every accepted major.minor.
   - Posting `DotnetVersionResolutionError` mirrors `validateVersionInput`/`getMajorMinor` so the
     failure shows up in telemetry the same way other bad-version rejections do.
   - The `try/catch` around `isFullySpecifiedVersion` matters: that classifier throws (not returns
     `false`) for inputs like `8.0.0`, so without the guard the helper would surface a confusing
     `DotnetFeatureBandDoesNotExistError` instead of the friendly message.
   - It does **not** resolve — it only validates shape, so it stays single-responsibility. The caller
     decides resolve-vs-passthrough with a single `isFullySpecifiedVersion` check (below).
   - Unit-test it directly (see Commit 5): `8.0`/`8.0.408` pass; `8`/`8.0.4xx`/`8.0.0`/garbage throw,
     and assert **no** `DotnetVersionParseEvent` is posted for the accepted `8.0` case.

3. Replace the version-resolution block with a **mode-aware** version: keep the existing lenient
   passthrough for runtime/aspnetcore, and call the new validator for SDK. Also rename
   `runtimeVersionResolver` → `versionResolver`:
   ```ts
   // imports from 'vscode-dotnet-runtime-library': assertValidLocalSdkVersion
   const versionResolver = new VersionResolver(workerContext);
   if (mode === 'sdk')
   {
       assertValidLocalSdkVersion(commandContext.version, globalEventStream, workerContext); // fail early on bad shape
       // After validation the version is either major.minor (2 parts) or fully-specified (>2 parts).
       // Use the segment count as the discriminator — do NOT re-call isFullySpecifiedVersion here, as it
       // posts a spurious parse event for the valid major.minor case (gap 5).
       if (commandContext.version.split('.').length === 2)
       {
           commandContext.version = await versionResolver.getFullVersion(commandContext.version, 'sdk'); // 8.0 -> latest patch
       }
       // else: fully-specified (e.g. 8.0.408) — install exactly. The pre-existing `>2 parts =>
       // forceUpdate=true` block above already forces the exact version, mirroring runtime.
   }
   else
   {
       // Existing runtime/aspnetcore behavior (unchanged): major.minor resolves; a fully-specified
       // 3-part version passes through to the install script (testing/pinning affordance).
       commandContext.version = commandContext.version.split('.')?.length > 2
           ? commandContext.version
           : await versionResolver.getFullVersion(commandContext.version, mode);
   }
   ```
   - The validator checks **shape** early; a well-formed but non-existent patch still surfaces as a
     not-found from the install script (acceptable, matches runtime).
   - **Do not** route runtime through `assertValidLocalSdkVersion` / `isFullySpecifiedVersion` — they
     are SDK-shaped and return `false` for `9.0.0` / `8.0.11` (would break the existing "Fully specified
     version installs specific version" runtime test). That is precisely why the branch is conditioned
     on `mode === 'sdk'`.

4. **Update the `IDotnetAcquireContext.version` doc-comment** (finding 10) in
   [vscode-dotnet-runtime-library/src/IDotnetAcquireContext.ts](vscode-dotnet-runtime-library/src/IDotnetAcquireContext.ts)
   to state the accepted formats per `mode` + `installType` (local runtime/aspnet: major.minor; local
   sdk: major.minor or fully-specified; global sdk: all four). Doc-comment only — no type-shape change.

5. Replace the dispatch ternary with a `switch` (per the user's request) and add the SDK branch:
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

6. **Do not** add `setPathEnvVar`. **Do not** add a `knownExtensionIds` check.

**Notes**
- The post-acquire `getInstallIdCustomArchitecture(...mode, 'local')` + `DotnetAcquisitionTotalSuccessEvent`
  block is already generic; no change.
- `getExistingInstallOffline` / `getSimilarExistingInstall` are mode-aware (compare `installMode`), so
  the offline pre-check already discriminates SDK vs runtime.

**Verify**
- `cd vscode-dotnet-runtime-extension && npm run compile`.
- Manual: `dotnet.acquire { version: '8.0', mode: 'sdk', requestingExtensionId }` installs an SDK
  under `<globalStoragePath>/.dotnet/<installId>` (its own folder, per Commit 1); PATH is unchanged.
- Manual: `dotnet.acquire { version: '8.0.408', mode: 'sdk' }` installs that exact SDK patch
  (fully-specified, now explicitly supported).
- `dotnet.acquire { version: '8.0', mode: 'sdk', installType: 'global' }` rejects with the new message.
- `dotnet.acquire { version: '8', mode: 'sdk' }` (major-only) and `{ version: '8.0.4xx', mode: 'sdk' }`
  (feature band) both reject **early** with the major.minor-or-fully-specified message (no install
  script invocation). Add both as tests in the tests commit.

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

## Commit 4 — Honor fully-specified versions in `acquireStatus` and `uninstall` (local)

**Goal:** make `dotnet.acquireStatus` and `dotnet.uninstall` address a **fully-specified** version
exactly (not just major.minor), so anything installed via `dotnet.acquire` — pinned SDK `8.0.408` or a
3-part runtime — can also be status-checked and uninstalled by that same string (finding 12). Applied
**mode-agnostically** so runtime and SDK share one contract (no matrix expansion).

Both downstream workers (`worker.acquireStatus`, `worker.uninstallLocal`) are already **exact
install-id** based and offline-capable, so the entire fix is in the two extension registrations: when
the version is already fully-specified (`split('.').length > 2`), skip `getFullVersion` (and, for
status, skip the major.minor offline pre-check) and use the version verbatim.

**File:** [vscode-dotnet-runtime-extension/src/extension.ts](vscode-dotnet-runtime-extension/src/extension.ts)

### A — `dotnetAcquireStatusRegistration`

Replace the unconditional resolve (and gate the major.minor offline pre-check) so a fully-specified
version is checked exactly:

```ts
// before:
//   const existingOfflinePath = await getExistingInstallOffline(worker, workerContext);
//   if (existingOfflinePath) return Promise.resolve(existingOfflinePath);
//   const runtimeVersionResolver = new VersionResolver(workerContext);
//   const resolvedVersion = await runtimeVersionResolver.getFullVersion(commandContext.version, commandContext.mode);
//   commandContext.version = resolvedVersion;
//   const dotnetPath = await worker.acquireStatus(workerContext, commandContext.mode);

const versionIsFullySpecified = commandContext.version.split('.').length > 2;
if (!versionIsFullySpecified)
{
    // major.minor path: the existing offline shortcut (getSimilarExistingInstall) is major.minor-grained,
    // and we resolve to the latest patch before the exact check.
    const existingOfflinePath = await getExistingInstallOffline(worker, workerContext);
    if (existingOfflinePath)
    {
        return Promise.resolve(existingOfflinePath);
    }
    const versionResolver = new VersionResolver(workerContext);
    commandContext.version = await versionResolver.getFullVersion(commandContext.version, commandContext.mode);
}
// fully-specified: skip the major.minor shortcut + resolution; worker.acquireStatus does an exact,
// offline-capable install-id check on the precise version.
const dotnetPath = await worker.acquireStatus(workerContext, commandContext.mode);
return dotnetPath;
```

- **Why skip the offline pre-check for fully-specified:** `getSimilarExistingInstall` returns the
  newest install with the *same major.minor*, which for a precise request could return a different
  patch. `worker.acquireStatus` needs no network (reads tracked state + disk + a local `dotnet
  --version`), so skipping the shortcut loses nothing and gains exactness.
- Update the misleading `runtimeVersionResolver` name → `versionResolver` and delete the now-stale
  "acquireStatus expects only a major.minor" comment.

### B — `uninstall` (local path)

The guard already skips resolution for `force` (UI) and for auto-update's
`onlyCheckLiveDependents` + multipart case. Generalize it to **always** skip resolution when the
version is fully-specified:

```ts
// before:
// if (commandContext.installType === 'local' && !force && !(onlyCheckLiveDependents && commandContext.version.split('.').length > 1))
const versionIsFullySpecified = commandContext.version.split('.').length > 2;
if (commandContext.installType === 'local' && !force && !versionIsFullySpecified)
{
    const versionResolver = new VersionResolver(ctx);
    commandContext.version = await versionResolver.getFullVersion(commandContext.version, commandContext.mode);
}
```

- `versionIsFullySpecified` (`> 2`) **subsumes** the old auto-update exception (`onlyCheckLiveDependents
  && > 1`), because auto-update always passes fully-specified versions. Net behavior change: only a
  *plain* `dotnet.uninstall` with a fully-specified version now skips resolution (the fix). Keep the
  existing auto-update functional tests green to confirm no regression.
- `worker.uninstallLocal` already builds the install via the exact `installId`, so the precise version
  flows straight through.

**Mode note:** the `> 2` check is mode-agnostic — runtime `9.0.0` and SDK `8.0.408` both pass. No
SDK-specific branch needed here (unlike acquire's *validation*, which is intentionally SDK-only).

**Verify**
- `cd vscode-dotnet-runtime-extension && npm run compile`.
- `dotnet.acquire` then `dotnet.acquireStatus` / `dotnet.uninstall` with the **fully-specified** version
  round-trips for both `mode: 'sdk'` (`8.0.408`) and `mode: 'runtime'` (`9.0.0`) — see tests in Commit 5.
- Existing auto-update + UI-uninstall tests still pass.

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

Add version-format tests reflecting the SDK validation (major.minor resolves; fully-specified is
explicitly supported; major-only and feature band fail **early**):

```ts
test('Local SDK acquire installs a fully-specified version', async () =>
{
    // Explicitly supported: a fully-specified patch installs that exact SDK.
    const context: IDotnetAcquireContext = { version: '8.0.408', requestingExtensionId, mode: 'sdk' };
    const result = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', context);
    assert.exists(result!.dotnetPath);
    assert.include(result!.dotnetPath, '8.0.408', 'The exact SDK patch is installed');
}).timeout(standardTimeoutTime);

test('Local SDK acquire rejects major-only and feature-band versions early', async () =>
{
    // Both are dotnet.acquireGlobalSDK-only; locally they fail version validation before any install.
    for (const version of ['8', '8.0.4xx'])
    {
        const context: IDotnetAcquireContext = { version, requestingExtensionId, mode: 'sdk' };
        await assert.isRejected(
            vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', context),
            /major\.minor|fully-specified/i,
            `Local SDK acquire should reject "${version}" early`);
    }
}).timeout(standardTimeoutTime);
```

Also add a **library unit test** for the extracted validator in
[vscode-dotnet-runtime-library/src/test/unit/VersionUtilities.test.ts](vscode-dotnet-runtime-library/src/test/unit/VersionUtilities.test.ts)
(faster + isolated from the install pipeline): `assertValidLocalSdkVersion` returns for `8.0` and
`8.0.408`, and throws for `8`, `8.0.4xx`, `8.0.4x`, `8.0.0` (band must be 2 digits), and non-numeric
garbage. This is the primary regression guard for the contract; the e2e tests above just confirm wiring.

Add fully-specified **status + uninstall round-trip** tests (the Commit 4 fix). Run for both SDK and
runtime to prove the unified, mode-agnostic behavior — and that a non-latest pin works:

```ts
test('Fully-specified version round-trips through acquire, status, and uninstall', async () =>
{
    for (const { version, mode } of [
        { version: '8.0.408', mode: 'sdk' as DotnetInstallMode },
        { version: '9.0.0', mode: 'runtime' as DotnetInstallMode }, // intentionally NOT the latest 9.0.x patch
    ])
    {
        const context: IDotnetAcquireContext = { version, requestingExtensionId, mode };

        const acquired = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', context);
        assert.exists(acquired!.dotnetPath, `${mode} ${version} installs`);

        // Status by the SAME fully-specified string must find the exact install (no resolution to latest).
        const status = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquireStatus', context);
        assert.exists(status, `acquireStatus finds the fully-specified ${mode} ${version}`);
        assert.include(status!.dotnetPath, version, 'status returns the exact pinned version, not a different patch');

        // Uninstall by the SAME fully-specified string must succeed (previously threw on resolve).
        const uninstall = await vscode.commands.executeCommand<string>('dotnet.uninstall',
            { ...context, installType: 'local' as DotnetInstallType });
        assert.equal(uninstall, '0', `uninstall of fully-specified ${mode} ${version} succeeds`);
        assert.isFalse(fs.existsSync(acquired!.dotnetPath!), 'the install is gone after uninstall');
    }
}).timeout(standardTimeoutTime * 2);
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
the deleted `dotnet-sdk.*` extension, whose `sample.dotnet-sdk.*` commands are removed in Commit 9).

**File:** [sample/src/extension.ts](sample/src/extension.ts)

- `sample.dotnet.acquireSDK` → reuse the existing `callAcquireAPI(version, 'sdk')` helper (it already
  posts `forceUpdate: true`, so a fully-specified version installs that exact SDK — the explicitly
  supported fully-specified path that lets you install a specific older SDK by hand).
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

**Auto-update (finding 7 / Commit 7):** local SDKs **are** auto-updated after Commit 7 (like runtimes).
The existing `sample.dotnet.resetUpdateTimer` command already forces an update pass, so it doubles as
the SDK auto-update demo — no SDK-specific update command is needed. You can optionally note in that
command's description that it now also updates local SDKs.

**Verify:** launch the Sample Extension; run `sample.dotnet.acquireSDK` (try `8.0` and a pinned
`8.0.408`), then `sample.dotnet.acquireSDKStatus`, `sample.dotnet.uninstallSDK`; confirm a local
runtime installed alongside survives the SDK uninstall.

---

## Commit 7 — Local SDK automatic updates

**Goal:** bring local SDKs into the same auto-update path as local runtimes/aspnet, while keeping
global SDKs excluded.

**File:** [vscode-dotnet-runtime-library/src/Acquisition/LocalInstallUpdateService.ts](vscode-dotnet-runtime-library/src/Acquisition/LocalInstallUpdateService.ts)
(`getInstallGroups`).

The only required code change is the group filter — drop the `installMode !== 'sdk'` clause, keep the
global exclusion, and rename the now-misnamed local variable:

```ts
// before: runtime + aspnet only
// const runtimeInstalls = (...getExistingInstalls(...)).filter(i => i.dotnetInstall.installMode !== 'sdk' && i.dotnetInstall.isGlobal !== true);
// after: all LOCAL installs (runtime, aspnet, AND sdk); global stays excluded.
const localInstalls = (await this.installTrackerType.getInstance(this.eventStream, this.extensionState)
    .getExistingInstalls(this.managementDirectoryProvider, false))
    .filter(i => i.dotnetInstall.isGlobal !== true); // global SDKs are user/OS-managed; never auto-update them (finding 11)
```

**Why nothing else needs to change (verified):**
- **Grouping** keys on `mode|architecture|majorMinor`. `getMajorMinorFromValidVersion('8.0.408')` =
  `8.0`, so SDK installs group correctly and separately from runtime (`mode` is part of the key).
- **Install/uninstall actions** are the generic `acquireLocal` / `uninstall` already wired in
  `extension.ts`. The auto-update acquire context uses `version: group.majorMinor` (`8.0`) +
  `mode: 'sdk'`; with Commit 2's SDK validation that resolves to the channel's latest SDK. Uninstall is
  path/installId-based and mode-agnostic. The per-install SDK folder (Commit 1A) and `~sdk` id
  (Commit 1B) are produced automatically by those calls.
- **"Latest in group" comparison** already compares the numeric third component (band+patch) and
  strips `-preview` suffixes, so `8.0.412` > `8.0.305` orders SDKs correctly. No change.
- **`managementDirectoryProvider` is the runtime provider**, but `getExistingInstalls` reads the global
  `installed` state under the constant `installedLk` lock (provider-independent), so it already returns
  SDK records; the runtime provider is only a lock/state handle here. No change, but note it in a
  comment.

**Semantics to document (finding 7):** SDK auto-update follows the channel's `latest-sdk`, which can
cross feature bands (`8.0.3xx` → `8.0.4xx`), unlike a runtime patch bump. This is the intended
"latest in channel" behavior; call it out in the changelog/docs.

**In-use protection (already works — just test it):** `markInstallAsInUse` is path-keyed and fires on
every acquire, so an SDK handed to a consumer is protected from the auto-update uninstall step exactly
like a runtime. No code change.

**Global exclusion (finding 11):** keep `isGlobal !== true`. Do **not** switch the filter to id-string
parsing — global SDK ids have no `~sdk` marker, so only the structured `isGlobal` field is reliable.

**Tests** — [vscode-dotnet-runtime-library/src/test/unit/LocalInstallUpdateService.test.ts](vscode-dotnet-runtime-library/src/test/unit/LocalInstallUpdateService.test.ts):
- Seed two local SDKs in one major.minor group (older + newer); run the update; assert the newest is
  kept, the older is uninstalled, and owners were transferred (mirror the existing runtime update test).
- Seed a **global** SDK record; run the update; assert it is **untouched** (never grouped).
- Seed an SDK marked in-use (current session); assert it is **not** uninstalled even if outdated.
- A mixed runtime+SDK state updates both independently (no cross-mode grouping).

**Verify:** `cd vscode-dotnet-runtime-library && npm run compile && npm run test`.

---

## Commit 8 — Docs + changelog (breaking change)

1. **[Documentation/commands.md](Documentation/commands.md) → `dotnet.acquire`:** document that `mode`
   may be `'runtime'` (default), `'aspnetcore'`, or `'sdk'`; that `mode: 'sdk'` performs a **local,
   user-folder SDK install**; that **PATH is not configured** for local SDK installs (the caller gets
   the path back via `IDotnetAcquireResult.dotnetPath` and is responsible for using it); that global
   SDK installs must use `dotnet.acquireGlobalSDK`; and that local SDKs **are auto-updated** like
   runtimes (after Commit 7), following the channel's latest SDK — which can cross feature bands
   (`8.0.3xx` → `8.0.4xx`). Global SDKs are **not** auto-updated.
   Add an explicit **accepted version formats** table so the runtime/local-SDK/global-SDK differences
   are unambiguous (this is the user-facing clarity the maintainer asked for):

   | Command (mode) | `major` (`8`) | `major.minor` (`8.0`) | feature band (`8.0.4xx`) | fully specified (`8.0.404`) |
   | --- | :---: | :---: | :---: | :---: |
   | `dotnet.acquire` runtime / aspnetcore | ❌ | ✅ | ❌ | ⚠️ testing-only passthrough |
   | `dotnet.acquire` **sdk (local)** | ❌ | ✅ | ❌ (rejected early) | ✅ |
   | `dotnet.acquireGlobalSDK` (sdk, global) | ✅ | ✅ | ✅ | ✅ |

   - Under `dotnet.acquire`, explicitly state: **local SDK supports `major.minor`** (e.g. `8.0`,
     resolved to the latest patch) **and fully-specified** (e.g. `8.0.408`, installed exactly).
     **Major-only and feature band (`8.0.4xx`) are rejected early** with a message pointing to
     `dotnet.acquireGlobalSDK`. Note the deliberate asymmetry with runtime: for SDK a fully-specified
     version is a *supported, validated* format; for runtime it remains an *unsupported testing
     passthrough* (and runtime has no feature bands).
   - Under `dotnet.acquireGlobalSDK`, the four-format list already exists; cross-link it from the
     `dotnet.acquire` SDK note so readers see where the *other* formats (major-only, feature band) are
     supported.
   - For runtime, clarify the existing reality: `major.minor` is the supported format; a
     fully-specified version is accepted as an **unsupported testing affordance** (passed through
     without resolution), and `major`-only / feature-band are not accepted.
   - Mirror this matrix in the `IDotnetAcquireContext.version` doc-comment (already updated in Commit 2,
     finding 10) so the in-code contract and the docs agree.
   - **`dotnet.acquireStatus` / `dotnet.uninstall` sections:** note they accept either a `major.minor`
     (resolved to the latest patch) **or** a fully-specified version (matched/removed exactly), for all
     modes (Commit 4). Remove the old "acquireStatus expects only a major.minor" caveat.
2. **[vscode-dotnet-runtime-extension/CHANGELOG.md](vscode-dotnet-runtime-extension/CHANGELOG.md):**
   add a **Breaking change** entry:
   - The standalone `vscode-dotnet-sdk` extension (`ms-dotnettools.vscode-dotnet-sdk`, unshipped for
     1+ year) is removed.
   - Consumers that previously called `dotnet-sdk.acquire` for a local SDK must call
     `dotnet.acquire` with `{ mode: 'sdk' }`. `dotnet-sdk.*` commands no longer exist.
   - Local SDK acquisition via `dotnet.acquire` accepts **`major.minor`** (e.g. `8.0`, resolved to the
     latest patch) and **fully-specified** (e.g. `8.0.408`, installed exactly). **Major-only and
     feature-band** formats are rejected early and remain a `dotnet.acquireGlobalSDK`-only capability.
   - Local SDKs now install under the VS Code-managed global-storage `.dotnet` folder in **one
     isolated subfolder per SDK version** (`<globalStorage>/.dotnet/<installId>/`). Previously every
     local SDK shared a single `%APPDATA%\.dotnet` / `~/.vscode-dotnet-sdk/.dotnet` folder. Old
     SDK-extension installs are orphaned (harmless) and may be removed manually.
   - Local SDKs are now **automatically updated** like local runtimes (older patches are replaced and
     uninstalled when not in use). Auto-update follows the channel's latest SDK and may cross feature
     bands (e.g. `8.0.3xx` → `8.0.4xx`). **Global** SDKs are not auto-updated.
   - `dotnet.acquireStatus` and `dotnet.uninstall` now accept a **fully-specified** version (not just
     `major.minor`) for all modes, so a pinned install can be status-checked and removed by the exact
     version string even after a newer patch ships.
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

## Commit 9 — Delete the SDK extension and all of its build wiring

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
   (`SdkInstallationDirectoryProvider`), `~sdk` install-id marker (`getInstallIdCustomArchitecture`),
   the `getAssumedInstallInfo` mode-precedence fix (gap 4), and the worker-test `getExpectedPath('sdk')`
   update; with unit tests. Prerequisite safety/correctness fix; must precede the acquire wiring.
2. **Commit 2** — `dotnet.acquire` local SDK dispatch (switch + `acquireLocalSDK`), a reusable
   `assertValidLocalSdkVersion` validator in `VersionUtilities` (major.minor + fully-specified; reject
   major-only/feature-band early), `IDotnetAcquireContext.version` doc update, and global rejection
   (testable immediately).
3. **Commit 3** — Local SDK modal events + republisher + new unit test.
4. **Commit 4** — Honor fully-specified versions in `acquireStatus` + `uninstall` (skip resolution when
   already 3-part; mode-agnostic, fixes finding 12).
5. **Commit 5** — Migrate/relocate tests; remove the unknown-extension-id test; add SDK status,
   fully-specified install, early major-only/feature-band rejection, uninstall-one/all, and isolation
   tests; rename `installRuntime`→`installLocal`.
6. **Commit 6** — Sample extension local SDK demo commands (acquire / status / uninstall / uninstallAll).
7. **Commit 7** — Local SDK automatic updates (`LocalInstallUpdateService` filter; keep global
   excluded) + unit tests.
8. **Commit 8** — Docs + changelog (breaking change).
9. **Commit 9** — Delete the SDK extension and all build/sample/pipeline wiring.

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
- **Local SDK version validation (extracted helper, mode-aware, fail-early).** A reusable
  `assertValidLocalSdkVersion(version, eventStream, context)` in `VersionUtilities` accepts `major.minor`
  (resolved) and fully-specified (e.g. `8.0.408`, installed exactly); major-only and feature band
  (`8.0.4xx`) are **rejected up front** via the existing classifiers (`isFullySpecifiedVersion` /
  `isNonSpecificMajorOrMajorMinorVersion`). It wraps `isFullySpecifiedVersion` in try/catch (that
  classifier *throws* for inputs like `8.0.0`) so the friendly message always wins, and posts
  `DotnetVersionResolutionError` for telemetry parity. **Runtime/aspnetcore are unchanged** (lenient
  `>2` passthrough) — deliberately, because `isFullySpecifiedVersion` is SDK-shaped and returns `false`
  for `9.0.0`/`8.0.11`; the call is conditioned on `mode === 'sdk'`. Unit-test the helper directly. Also
  update the `IDotnetAcquireContext.version` doc-comment so the contract matches.
- **High blast radius.** `dotnet.acquire` is the single most-used command. Keep the acquire commit
  (Commit 2) additive: a new `case 'sdk'` in the dispatch switch, a global-reject guard, and the SDK
  validation branch wrapped in `if (mode === 'sdk')` — the runtime/aspnetcore resolution path is
  **unchanged**.
- **Fully-specified status/uninstall (Commit 4, finding 12).** Both registrations previously always
  resolved via `getFullVersion`, so a pinned non-latest version threw. The fix skips resolution when
  `version.split('.').length > 2` (mode-agnostic) and, for status, also skips the major.minor offline
  shortcut so the exact patch is returned. Net behavior change is narrow: a *plain* `dotnet.uninstall`
  / `dotnet.acquireStatus` with a fully-specified version now addresses it exactly instead of failing.
  Risk: the uninstall change subsumes the old `onlyCheckLiveDependents && >1` auto-update exception —
  rerun the auto-update + UI-uninstall functional tests to confirm parity. This also retroactively
  makes runtime fully-specified status/uninstall robust (previously latent, masked by auto-update).
- **SDK auto-update crosses feature bands (Commit 7).** Resolving `major.minor` for SDK yields the
  channel's `latest-sdk`, so an auto-update can move a managed local SDK across feature bands
  (`8.0.3xx` → `8.0.4xx`), a larger jump than a runtime patch. This is intentional "latest in channel"
  parity with runtime, but flag it for telemetry/UX owners and the changelog. The outdated SDK is only
  uninstalled if not in use (path-keyed live-dependent check).
- **Auto-update id-encoding asymmetry (findings 7 & 11).** Local SDK ids carry `~sdk` and auto-update;
  global SDK ids carry only `-global` (no `~sdk`) and are excluded. The filter **must** stay on the
  structured `installMode`/`isGlobal` fields, never id-string parsing. If global **runtime** support is
  ever added, global ids will need a mode marker (the mirror of the local case) and the auto-update
  filter will need to distinguish runtime-vs-sdk for global installs, not just `isGlobal`.

---

## Potential gaps / open edges (reviewer-raised)

These were raised during review. Each is assessed as **fix now** (folded into the commits above) or
**follow-up** (safe to defer), with rationale. Short version: gaps **4, 5, 9 are handled in-plan**;
the rest are genuine but deferrable, with a couple I'd recommend opportunistically hardening.

### Handled in this plan

- **(4) `getAssumedInstallInfo` mislabels explicit SDK mode — FIX NOW.** Confirmed operator-precedence
  bug (`??` binds tighter than `?:`, so any non-null `mode` returns `'runtime'`). Because Commit 2
  routes accepted major.minor SDK requests through `getFullVersion(_, 'sdk')`, SDK resolution failures
  now reach this helper with `mode === 'sdk'` and would be mislabeled `runtime` in telemetry. Fixed as
  **Commit 1 Part C** (one-line parenthesization + unit tests). Agree with the reviewer that this one
  shouldn't wait.
- **(5) Noisy parse telemetry from the validator — FIX NOW (it's our new code).** The first draft of
  `assertValidLocalSdkVersion` called `isFullySpecifiedVersion` on every input, which posts a
  "bad long form" parse event for a valid `8.0`. Reworked in **Commit 2** to check segment count first
  and only call the strict classifier for 3-part candidates; the caller likewise uses segment count
  (not `isFullySpecifiedVersion`) for the resolve-vs-use decision. Added a unit assertion that no parse
  event fires for the accepted `8.0` case. No reason to defer a fix to code we're introducing.
- **(9) Exact-patch status/uninstall — FIX NOW (already Commit 4).** This is the same issue as
  finding 12 and is fully addressed by **Commit 4** (skip resolution when the version is already
  fully-specified, mode-agnostically). Listed here only to close the loop; nothing left to defer.

### Recommended follow-ups (safe to defer; a couple worth opportunistic hardening)

- **(1) `existingDotnetPath` short-circuits local SDK acquisition — FOLLOW-UP (recommend a small
  now-decision).** Confirmed: `acquireLocal` calls `resolveExistingPathIfExists` with **no** mode
  guard, and `ExistingPathResolver` returns the configured path when `providedPathMeetsAPIRequirement`
  (mode-aware) passes — so `dotnet.acquire { mode:'sdk' }` can hand back a configured/global SDK path
  instead of installing a local one, contradicting the "local SDK + don't set PATH" contract. Defensible
  as a follow-up because it only triggers when a user has *explicitly* configured a path, and honoring
  an existing SDK is arguably desirable. But the behavior is currently implicit. **Recommendation:** at
  minimum document it in Commit 8; ideally make a one-line conscious choice in Commit 2 — either skip
  the path setting for SDK (mirroring `findPath`'s `mode !== 'sdk'` guard) or keep it and document that
  `existingDotnetPath` overrides local SDK acquisition. Cheap; I'd lean toward deciding it alongside
  Commit 2 rather than discovering it in the field.
- **(2) `x-dotnet-acquire` becomes a hidden SDK entry point — FOLLOW-UP.** Confirmed: `JsonInstaller`
  forwards the package-json request verbatim to `dotnet.acquire` on startup/extension-change, so once
  `mode:'sdk'` is accepted, any extension's `package.json` can trigger a local SDK install at launch
  (and `installType:'global'` would hit the new global-reject guard). This is a **policy** question
  more than a bug: do we want JSON-declared SDK installs? **Recommendation:** follow-up — decide policy
  (allow SDK; reject/log `global` from the JSON path with a clear event), and add `JsonInstaller` tests
  for an SDK request and a rejected global request (today's tests only cover the no-request scan). Not
  blocking because the global-reject guard already prevents the most dangerous case (silent elevated
  install), and a local SDK install is bounded/uninstallable.
- **(3) `acquireGlobalSDK` defaults mode but doesn't enforce it — FOLLOW-UP (cheap; consider now).**
  Confirmed `commandContext.mode = commandContext.mode ?? 'sdk'`, so a caller passing `mode:'runtime'`
  builds the global installer with a runtime context. Pre-existing, but the migration makes the
  runtime↔sdk boundary load-bearing. **Recommendation:** a one-line hardening (force `mode = 'sdk'`, or
  reject non-sdk with a clear message) that pairs naturally with Commit 2's global-reject work; do it
  then if convenient, otherwise a small follow-up. Low risk either way.
- **(6) `findPath` (and the LM tool) skip extension-managed installs for SDK — FOLLOW-UP.** Confirmed
  `findPath` guards `mode !== 'sdk'` for both the setting and the extension-managed lookup, and
  `commands.md` documents that. After local SDK acquisition this is surprising: we can install a local
  SDK but not rediscover it via `findPath`. This is a **larger** change (SDK path-search semantics, LM
  tool messaging that currently claims it searched extension-managed installs) and is orthogonal to the
  acquire/status/uninstall round-trip the plan delivers. **Recommendation:** follow-up; in the meantime
  Commit 8 should explicitly document that local SDKs are returned via `acquire`/`acquireStatus`, not
  `findPath`. Track as its own work item so the LM tool messaging is fixed in lockstep.
- **(7) LM `uninstall_vscode_owned_dotnet_runtime` is runtime-only — FOLLOW-UP.** Confirmed the tool
  description forbids SDKs and the implementation hardcodes runtime/aspnetcore. Once local SDKs are
  managed installs, agents have no local-SDK uninstall tool and could misroute to system-SDK uninstall.
  This is **LM-surface scope**, not core acquisition. **Recommendation:** follow-up — decide whether to
  extend the tool to local SDKs (preferred for symmetry with the new capability) or keep it
  intentionally unavailable; update the tool description either way. Note it next to gap 6 since both
  are LM-tool consistency items and should ship together.
- **(8) Auto-update test helper uses non-real ids — ADDRESS IN COMMIT 7; existing helper cleanup is
  FOLLOW-UP.** Confirmed `LocalInstallUpdateService.test.ts` synthesizes ids as
  `${version}~${arch}~${installMode}${isGlobal?'~global':''}`, which matches **neither** real runtime
  ids (no mode suffix), real global SDK ids (`-global`, no `~sdk`), nor the plan's asymmetric local/
  global SDK marker rule. New SDK auto-update tests that reuse this helper could pass while missing the
  exact id-encoding bug Commit 1B guards against. **Recommendation:** the **new** SDK auto-update tests
  in Commit 7 must build ids via `getInstallIdCustomArchitecture` (real encoding); migrating the
  pre-existing helper/fixtures to the real function is a separate cleanup that can be a follow-up.

**Net:** I agree the bulk are deferrable. The only one I'd insist on (and have folded in) is **gap 4**;
**5 and 9** are already in-plan; and I'd nudge to make a deliberate one-line decision on **1** and **3**
while we're in `acquireLocal`/`acquireGlobalSDK` rather than leaving them implicit. If you'd rather keep
this PR tightly scoped, 1/2/3/6/7/8-cleanup are all reasonable standalone follow-ups — none blocks the
core local-SDK capability.
