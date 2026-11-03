# Mac app: signing and notarization

Without this, the Mac download is ad-hoc signed. macOS blocks a browser-downloaded copy with "is damaged and can't
be opened", and users need a terminal command to install it. With it, a release tag builds an app that Apple has
checked, and it opens on any Mac with no prompt.

`.github/workflows/release-mac.yml` does the work when five repository secrets exist. With none of them it builds
the ad-hoc app as before, so nothing breaks while this is not set up.

## What you need (one time)

1. **Apple Developer Program** membership (US$99 a year): https://developer.apple.com/programs/
2. **A "Developer ID Application" certificate.** Only the account holder can create it. In Xcode: Settings,
   Accounts, your team, Manage Certificates, +, Developer ID Application. Then in Keychain Access, find it under My
   Certificates, right-click, Export, and save a `.p12` file with a password.
3. **An App Store Connect API key** for notarization: https://appstoreconnect.apple.com/access/integrations/api,
   Team Keys, Generate API Key (role: Developer). Download the `.p8` file (Apple lets you do it once) and note the
   **Key ID** and the **Issuer ID** shown at the top of the page.

## The five secrets

Run these in this repository, where `cert.p12` and `AuthKey_XXXXXXXXXX.p8` are the files from above:

```
base64 -i cert.p12 | gh secret set APPLE_CERTIFICATE_P12
gh secret set APPLE_CERTIFICATE_PASSWORD        # the .p12 password
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID                  # like 2X9R4HXF34
gh secret set APPLE_API_ISSUER_ID               # a UUID
```

## Release a notarized build

Tag as usual (`git tag -a v0.1.10 -m ... && git push origin v0.1.10`), or rebuild an existing tag:

```
gh workflow run release-mac.yml -f tag=v0.1.9
```

The workflow imports the certificate into a temporary keychain, builds the universal app, signs it with the hardened
runtime (`mac/entitlements.plist`, which the Bun-compiled board needs), sends it to Apple with `notarytool`, staples
the ticket, checks `spctl --assess` and `stapler validate`, and attaches the zip. Notarization usually takes a few
minutes. If Apple rejects it, the job fails and prints the log; the previous release stays the latest.

To check a download yourself:

```
unzip -q Run-My-Agents-macOS.zip && spctl --assess --type execute -v "Run My Agents.app"
# Run My Agents.app: accepted, source=Notarized Developer ID
```

Once a notarized release is out, the "damaged" note and the terminal install on the home page and in the README can
go.

## Locally

`RUN_MY_AGENTS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" mac/build.sh --release` signs your build;
`APPLE_API_KEY_PATH=... APPLE_API_KEY_ID=... APPLE_API_ISSUER_ID=... mac/notarize.sh` notarizes it.
