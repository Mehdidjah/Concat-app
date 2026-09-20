# App updates

Concat can notify users when a newer **published release** is available for
their operating system and CPU architecture. A commit, push, merged pull
request or successful CI build alone does not notify installed apps.

## What users see

Automatic checks are enabled by default and can be turned off in Settings →
About. Shortly after startup, and while the app remains open, the app checks
only if at least a day has passed since the last attempt (also remembered
across restarts). Settings → About → **Check for updates** checks immediately.
A newer compatible release opens an update dialog with its version and a link
to the release. Users can choose **View release**, **Later**, or **Skip this version**.
A pending dialog waits for playback and other editing dialogs to close.
**Later** postpones the automatic reminder until the next daily check;
**Skip this version** persists until a different version is available.
A manual check can show a version that was skipped.

The check reads public release metadata from GitHub. GitHub receives the
normal connection information, such as the IP address and request headers;
Concat does not send projects, media, account credentials or usage telemetry.
Automatic checks can be disabled, and offline editing continues to work.
Downloads and installation are never performed silently by this checker.

Stable builds are offered newer stable versions. A build whose compiled
version contains a prerelease suffix can also see newer prereleases. Draft
releases, model-mirror releases, older versions and releases without a matching
platform artifact are not offered. The comparison uses semantic versions,
not commit dates or lexicographic string ordering.

An old app that does not contain this checker cannot discover it remotely.
Install a version containing this feature once; later releases can then be
announced by the app.

## Installing the offered version

Save your project before closing the app to install an update. Keep the same
installation source and package type:

- **Windows:** use the installer matching your existing installation and CPU.
  The per-user `.exe` and managed, per-machine `.msi` are different install
  methods; do not switch between them as an automatic upgrade.
- **macOS:** install the `.dmg` for Apple silicon or Intel and replace the app
  through the normal installer/Finder flow. Signing and notarization depend
  on the release publisher's configuration, not on the notification dialog.
- **Linux:** use the matching `.deb`, `.rpm` or `.AppImage`. If a distribution
  package manager or Nix supplied the app, update through that source instead.
- **Android:** install the publisher's APK through Android's confirmation
  flow. An update must use the same package ID and compatible signing key.
  If a store supplied the app, use that store's update flow.
- **iOS / iPadOS:** current builds are experimental, sideloaded `.ipa` files.
  Update using the original sideloading tool and signing identity. The app
  does not install an IPA itself. A future App Store/TestFlight distribution
  needs its own supported store-update flow; none is configured here.

## Publishing a version

1. Finish and test the changes, then raise `[workspace.package].version` in
   `src/Cargo.toml` and refresh the workspace lockfile with Cargo. Use a new
   version for a new public release; do not replace an old tag's binaries and
   expect installed apps to detect new features.
2. Configure the publisher's signing credentials. Published Android builds
   require persistent `ANDROID_KEYSTORE` and `ANDROID_KEYSTORE_PASSWORD`
   secrets. Keep a secure backup of the original key: a newly generated key
   cannot upgrade users' existing APKs. PR/test builds may use a disposable
   key, and must not be distributed as a long-lived update channel.
3. Check the mobile package versions as well as the user-visible version.
   [`cargo-apk` derives Android's version code from the crate version](https://github.com/rust-mobile/cargo-apk/blob/main/cargo-apk/src/apk.rs).
   A new store release needs a strictly increasing
   `versionCode`; prerelease tags alone do not change the workspace version
   or that code. This workflow does not allocate mobile build numbers.
   For multiple store/prerelease uploads of one version, introduce and verify
   a monotonic build-number policy before distributing them.
   See [Android's versioning requirements](https://developer.android.com/studio/publish/versioning)
   and [app-signing requirements](https://developer.android.com/studio/publish/app-signing).
4. Commit the tested version change and create/push a matching tag, for example
   `v0.2.4`. A tag such as `v0.2.4-alpha.1` publishes a prerelease built from
   workspace version `0.2.4`. The **Release** workflow can also be dispatched
   with an existing tag.
5. Wait for every desktop and phone build, packaging job and release
   publication to succeed. The workflow resolves the tag to one commit SHA
   and builds that commit for every target, including manual dispatches.
6. Download and smoke-test the actual published artifacts on each supported
   OS/architecture. Test an upgrade from the previous installation, check
   signatures where applicable, and confirm projects/settings remain usable.
   Then check from an older updater-enabled app that the published version
   is offered and that its release link belongs to the correct publisher.

The release publishes platform installers, `SHA256SUMS`, and `manifest.json`.
The manifest records platform/architecture/package type, sizes and SHA-256
digests for the files that actually exist. Asset names use the workspace
version (`Concat-0.2.4-…`), while the release tag may include a prerelease
suffix. A notification is not proof that an installer has been signed,
notarized or tested; those are separate release checks. No new distribution
artifact has been built or certified merely by configuring these workflows.

## Forks and source builds

Desktop and phone release workflows set these compile-time variables:

| Variable | Meaning |
|---|---|
| `CONCAT_RELEASE_REPOSITORY` | GitHub `owner/repository` publishing this app |
| `CONCAT_RELEASE_VERSION` | Exact version/tag being built, including any prerelease suffix |

The workflows use their own `${{ github.repository }}` and the checked release
tag, so a fork's app checks the fork's releases rather than switching users
to upstream. For a local fork build, set these explicitly, for example:

```sh
cd src
CONCAT_RELEASE_REPOSITORY=Mehdidjah/Concat-app \
CONCAT_RELEASE_VERSION=v0.2.4 \
cargo build --profile app -p concat
```

When unset, the source-build defaults are the upstream repository and Cargo's
package version. Release builds should always set both. Keep the release
repository stable after shipping: existing apps continue checking the source
compiled into them.

The release-manifest script accepts `--repository owner/name` for app artifact
URLs. This does **not** move the optional model mirror: model URLs still come
from their configured upstream source. Its offline regression tests run with:

```sh
python3 -m unittest discover -s scripts -p 'test_models.py'
python3 scripts/models.py --check
```
