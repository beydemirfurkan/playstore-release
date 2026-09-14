# Setup

Everything here happens once per app. After it, the API does the work.

## 1. The app exists in the Play Console

Google Play Console → **Create app**: name, default language, App/Game, Free/Paid, the declarations checkboxes. This is Console-only; the API cannot create an app. Note the two ids in the URL afterwards — `developers/<dev>/app/<app>/` — and put them in `config.console.developerId` / `config.console.appId` so `check` renders deep links.

**Free is permanent.** A free app can never be switched to paid.

## 2. A service account with a JSON key {#service-account}

In Google Cloud (any project you own; a dedicated one is tidiest):

```bash
gcloud projects create my-app-play --name "My App Play"          # or reuse an existing project
gcloud services enable androidpublisher.googleapis.com --project my-app-play
gcloud iam service-accounts create playstore-release --project my-app-play --display-name "playstore-release"
gcloud iam service-accounts keys create ./service-account.json \
  --iam-account playstore-release@my-app-play.iam.gserviceaccount.com --project my-app-play
```

No IAM role is needed on the Cloud project — permissions are granted inside the Play Console, not in Cloud IAM.

## 3. Invite the service account in the Play Console

Play Console → **Users and permissions** → **Invite new users** → paste the `client_email` from the JSON → **App permissions** → add the app → tick:

- **Release to testing tracks** (internal/closed/open)
- **Release to production, exclude devices, and use Play App Signing**
- **Manage store presence** (listing, graphics, contact details)
- **View app information and download bulk reports** (read-only inventory)
- optionally **Reply to reviews**

→ **Invite user**. The account is "active" immediately, but **API calls can keep answering 403 for up to 24 hours** while the grant propagates. `doctor` names this.

Older documentation says to "link a Cloud project" under Settings → API access. That page still exists and still works, but inviting the service-account email as a user is the supported path today and needs no linking.

## 4. The first bundle, by hand

Google refuses the very first upload of an app through the API — the bundle has to go through the Console once. Build it with the project's pipeline, then Console → **Testing → Internal testing → Create new release → Upload**. Accept **Play App Signing** when asked (Google holds the app signing key; your keystore is only the upload key). Save and publish the internal release.

From now on `playstore-release upload-bundle` (or CI's own publishing step) uploads every later bundle.

## 5. Environment

```bash
export PLAY_SERVICE_ACCOUNT_JSON=/abs/path/service-account.json   # a path, or the JSON itself, or its base64
export PLAY_PACKAGE_NAME=com.example.app                            # or `packageName` in the config
export PLAYSTORE_CONFIG=/abs/path/playstore.config.json             # optional; discovered otherwise
```

```bash
playstore-release doctor
```

## 6. Secrets hygiene

Add to the project's `.gitignore`:

```
*service-account*.json
*.jks
*.keystore
secrets/
playstore.config.json      # only if console.appAccess.password is filled in
```

The service-account JSON authenticates _every_ app the account is invited to. Treat it like a password: never in a tool argument, never in a chat, never in a build log. Rotating it (delete the key in Cloud IAM, create a new one) breaks nothing in the Console.

## 7. Building the bundle is not this tool's job

`playstore-release` starts at the signed `.aab`. Produce it with:

- **Capacitor / native**: `cd android && ./gradlew bundleRelease` with a `signingConfigs.release` that reads the upload keystore.
- **Expo**: `eas build -p android --profile production`.
- **CI**: Codemagic's `android_signing` + `google_play` publishing block, GitHub Actions with `r0adkll/upload-google-play`, or fastlane `supply`. When CI already uploads to internal, leave `config.bundle` out and let `publish` pick the newest bundle Play holds.

`versionCode` must rise with every upload — Play remembers every code it has ever seen, even for deleted releases.
