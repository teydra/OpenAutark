# Signing and TestFlight for the Autark iPhone app

The goal: once the Apple Developer Program account exists, **one** run of `.github/workflows/testflight.yml` produces a signed
build in TestFlight. Nobody needs a Mac, a certificate file or a provisioning profile. Xcode signs automatically through an App
Store Connect API key:

- `xcodebuild archive -allowProvisioningUpdates -authenticationKey…` registers the missing App IDs (`com.teydralab.autark`,
  `.widgets`, `.share`), puts the App Group and Push on them, and creates a development certificate and profiles to archive with.
- `xcodebuild -exportArchive` (method `app-store-connect`) signs with Apple's **cloud-managed distribution certificate**.
- `xcrun altool --upload-package` uploads the `.ipa`.

A Linux preflight job checks the key, the app record, a registered device and the next build number before the macOS job starts
(macOS minutes count tenfold in a private repository).

## Steps after paying, in order

Steps 1–5 and 8 can only be done on Apple's websites (developer.apple.com, appstoreconnect.apple.com) by Stanislaus as Account
Holder. Steps 6–7 are GitHub. Step 4 can also go through the API once the key from step 3 exists.

1. **Accept the agreements.** In App Store Connect > Business, the Account Holder accepts the latest agreement. No app can be added
   before that. ([Add a new app](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app))
2. **Read the Team ID.** developer.apple.com > Account > Membership details: a 10-character string. It becomes the secret
   `APPLE_TEAM_ID`. ([Team ID](https://developer.apple.com/help/glossary/team-id))
3. **Create the API key.**
   - Request API access first: Users and Access > Integrations > App Store Connect API > Request Access. Only the Account Holder can
     request it, and Apple reviews each request "on a case-by-case basis", so it may not be instant.
   - Then Team Keys > Generate API Key, name `Autark CI`, role **Admin**. Admin is needed because cloud-managed certificates require
     the Account Holder or Admin role.
   - Download `AuthKey_<KEYID>.p8`. It can be downloaded **only once**. Note the Key ID and the Issuer ID shown above the list.
   - Sources: [App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api),
     [Cloud-managed certificates](https://developer.apple.com/help/account/certificates/cloud-managed-certificates).
4. **Register the iPhone, the main App ID and the App Group** (Certificates, Identifiers & Profiles):
   - **Devices > +**: platform iOS, name and UDID of the agreed test iPhone, with the device owner's consent. A development profile needs a registered device; the automatic-signing archive may need one. TestFlight installation itself does not require enrolling the device.
     ([Register a single device](https://developer.apple.com/help/account/devices/register-a-single-device))
     On Windows, the UDID comes from `ios list` (go-ios) with the iPhone on USB. The PC's iPhone runner needs the same
     registration anyway.
   - **Identifiers > + > App IDs > App**: Explicit, Bundle ID `com.teydralab.autark`, description `Autark`, capabilities
     **App Groups** and **Push Notifications**. The App Store Connect app record in step 5 must match this bundle ID.
     ([Register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id))
   - **Identifiers > + > App Groups**: `group.com.teydralab.autark`. Xcode can create it too, but doing it by hand removes one
     unknown from the single run. ([Register an app group](https://developer.apple.com/help/account/identifiers/register-an-app-group))
   - The extensions' App IDs (`com.teydralab.autark.widgets`, `com.teydralab.autark.share`) are left to Xcode.
5. **Create the app record.** App Store Connect > Apps > + > New App:
   - Platform iOS, name `Autark`, primary language English (U.S.), Bundle ID `com.teydralab.autark`, SKU `autark-ios`, Full Access.
   - The API cannot create apps: "create new apps on the App Store Connect website"
     ([Apps API](https://developer.apple.com/documentation/appstoreconnectapi/apps)).
   - A name can be used by only one app per localization. If `Autark` is taken on the App Store, pick another display name for the
     store. The name on the home screen stays `Autark` (`CFBundleDisplayName`).
     ([Add a new app](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app),
     [App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information))
6. **Set four repository secrets** (GitHub > teydra/proactive-agent-runtime > Settings > Secrets and variables > Actions, or
   `gh secret set NAME`): `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_KEY_P8_BASE64`. The last one is the `.p8` file
   as one base64 line:
   - Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXX.p8")) | gh secret set ASC_KEY_P8_BASE64 --repo teydra/proactive-agent-runtime`
   - Linux: `base64 -w0 AuthKey_XXXX.p8 | gh secret set ASC_KEY_P8_BASE64 --repo teydra/proactive-agent-runtime`

   The key file itself goes into the team's secrets catalog, not into the repository.
7. **Start the workflow.**
   - GitHub lists a `workflow_dispatch` workflow only once the file is on the default branch, so `testflight.yml` has to reach
     `main` first ([GitHub: workflow_dispatch](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_dispatch)).
   - Then Actions > iOS TestFlight > Run workflow, or `gh workflow run testflight.yml --ref main`. Leave `build_number` empty;
     the preflight picks one above the highest existing build.
   - The macOS minutes must be available. Budget about 15 runner minutes, which count 150 against the quota.
   - The run summary shows the bundle IDs, versions, signing authority and entitlements of every bundle, plus the TestFlight link.
8. **TestFlight for Stanislaus.** When the build has processed (an email arrives, usually within half an hour):
   - **Export compliance:** the build shows "Missing Compliance" until the encryption questions are answered once
     ([Overview of export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)).
     The app uses standard algorithms through CryptoKit (AES-GCM, X25519, Ed25519, HKDF) for its own end-to-end channel to the
     PC, so the answer is not simply "no encryption". The account holder decides it. Once it is decided, the key
     `ITSAppUsesNonExemptEncryption` (and, if needed, `ITSEncryptionExportComplianceCode`) can go into `Info.plist` so later
     builds skip the question ([Complying with encryption export regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)).
   - **Internal test:** add Stanislaus to a named internal testing group; leave automatic distribution off for the
     first run. Upload, processing and inviting testers are separate steps.
     ([Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers))
   - **Test on a friend's iPhone:** if the friend is the tester, use a named external email invitation after Konrad
     approves it. Don't give the friend an App Store Connect role or share the Account Holder's login. The first
     external build must pass TestFlight App Review. No public link. Keep APNs off for this build unless its use for
     the external test has been explicitly agreed.
     ([Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/))
   - **Autark Control** is a separate developer-signed runner, not installed by TestFlight. TestFlight acceptance
     does not prove Windows can start the runner on the registered iPhone.


## What else is fixed in the project for this

- Every target signs `Automatic` (`project.yml` base setting). The team is never in the spec; the workflow passes
  `DEVELOPMENT_TEAM`. The Simulator builds keep `CODE_SIGNING_ALLOWED=NO` and do not change.
- Entitlements come from `project.yml`, and XcodeGen writes the `.entitlements` files:
  - app, widgets and share: App Group `group.com.teydralab.autark`;
  - app only: `aps-environment` (Push on the App ID). Push stays off in the app (`AutarkPushEnabled: false`) until APNs has a sender.
  - Live Activities need no entitlement, only `NSSupportsLiveActivities` in Info.plist.
- `Autark/Resources/PrivacyInfo.xcprivacy` declares the one required-reason API the app uses, `UserDefaults` (reason `CA92.1`).
  Without it, App Store Connect reports ITMS-91053.
  ([Describing use of required reason API](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api))
- Uploads must be built with Xcode 26 and the iOS 26 SDK. The workflow selects Xcode 26.3 and stops on anything older.
  ([SDK minimum requirements](https://developer.apple.com/news/upcoming-requirements/))
- Build numbers: a build is identified by bundle ID, version and build string
  ([App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)). The
  preflight takes the highest build App Store Connect has, adds one, and passes it as `CURRENT_PROJECT_VERSION`; the app and both
  extensions read it. The version (`MARKETING_VERSION`, now 0.1.0) changes in `project.yml`.
- The runner target (`AutarkRunnerUITests`, "Autark Control") is not in the `Autark` scheme's archive and never goes to TestFlight.

## Not verified yet (the first run shows it)

- **Admin key and cloud signing from `xcodebuild`.** Apple documents the Account Holder/Admin requirement for cloud-managed
  certificates in general, not for API keys. Developer reports say only Admin keys work, and that a key cannot be given the
  separate "Access to Cloud Managed Distribution Certificate" permission
  ([forum 810658](https://developer.apple.com/forums/thread/810658), [forum 698117](https://developer.apple.com/forums/thread/698117)).
- **Extension App IDs.** That `xcodebuild` with an API key registers the extension App IDs and assigns App Group and Push the way
  the Xcode app does. Apple describes this for Xcode's automatic signing; steps 4b–4c take the riskiest part off.
- **Development certificate per run.** The private key of the development certificate that Xcode creates for the archive dies with
  the runner, so each run creates a new one ("Created via API"). If Apple's certificate limit is reached, revoke old ones under
  Certificates, or later keep one development certificate as a secret.
- **altool's exit code.** Xcode 26's altool was reported to exit 0 on a failed upload; the workflow therefore also reads its output.
  ([Bitrise note](https://discuss.bitrise.io/t/deploy-to-app-store-connect-application-loader-formerly-itunes-connect-v2-0-0/25564),
  [altool man page](https://keith.github.io/xcode-man-pages/altool.1.html))
- **No other required-reason API.** A search of the sources found only `UserDefaults` in the app and its extensions. If
  App Store Connect mails an ITMS-91053 for another API or bundle, add it to the manifest.
