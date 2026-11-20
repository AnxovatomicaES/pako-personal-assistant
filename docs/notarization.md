# Notarizing Pako for Mac

For the owner, when you decide to do it. Nothing here has been bought or enrolled yet. Until it is done, a downloaded `Pako.app` is
blocked once by Gatekeeper, and people get past it with **Open Anyway** (README, "Install"). Notarized, it opens on the first try with only
macOS's usual "downloaded from the internet" question.

The release scripts are already written for it: you only add an identity and a profile name to the environment.

## What it costs

| What | Cost | Notes |
| --- | --- | --- |
| Apple Developer Program | **99 USD a year** (or the local price) | Needed for a Developer ID certificate. Enrol as an individual (your name shows as the developer) or as an organisation (needs a legal entity and a free D-U-N-S number, and takes longer to verify). |
| Developer ID Application certificate | free with the membership | Valid five years. Only the account holder can make one. |
| Notarization (`xcrun notarytool`) | free | Usually a few minutes per upload. |
| Xcode | not needed | The Command Line Tools have `notarytool` and `stapler` (`xcode-select --install`). |

If the membership lapses later, copies already notarized keep opening; you just can't notarize new releases until you renew.

## Once: the account, the certificate and the profile

1. **Enrol** at [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/) with an Apple Account that has
   two-factor authentication on. Pay the 99 USD. Wait for the confirmation email (often a day or two for an individual).
2. **Note your Team ID**: developer.apple.com → Account → Membership details (ten characters, like `AB12CD34EF`).
3. **Make the Developer ID Application certificate**, on the Mac that will make releases:
   - Keychain Access → Certificate Assistant → *Request a Certificate From a Certificate Authority*: your email, "Saved to disk".
   - developer.apple.com → Certificates, Identifiers & Profiles → Certificates → **+** → **Developer ID Application** (the "G2 Sub-CA"
     choice) → upload the request → download the `.cer` and double-click it.
   - Check: `security find-identity -v -p codesigning` lists `Developer ID Application: <Your Name> (<TEAMID>)`.
   - Back up the private key (export the certificate with its key as a `.p12` from Keychain Access) somewhere safe and offline.
4. **Make an app-specific password** for notarytool: [account.apple.com](https://account.apple.com) → Sign-In and Security →
   App-Specific Passwords → **+**, call it "notarytool".
5. **Store the notary profile** in the login keychain (it asks for that app-specific password, and keeps it there):

   ```sh
   xcrun notarytool store-credentials pako-notary --apple-id <your Apple Account email> --team-id <TEAMID>
   ```

   The scripts never take an Apple ID, password or key: only the identity's name and this profile's name.

## Each release

```sh
PAKO_SIGN_IDENTITY='Developer ID Application: <Your Name> (<TEAMID>)' PAKO_NOTARY_PROFILE=pako-notary npm run mac-release
```

(Add `PAKO_UPDATE_FEED=…` and the feed signing key as in [desktop-mac.md, "Make a release"](desktop-mac.md#make-a-release).)

Where it plugs in, in `desktop/mac/release.sh`, in this order:

1. `build.sh`: the app, with Node.js and the server inside it.
2. `sign.sh`: signs Node.js and then the app with `PAKO_SIGN_IDENTITY`, the hardened runtime and a secure timestamp (both are required by
   notarization). Without the variable it signs ad hoc, which is what ships today.
3. `notarize.sh Pako.app`: zips the app, `xcrun notarytool submit --keychain-profile "$PAKO_NOTARY_PROFILE" --wait`, prints Apple's log
   on a rejection, then `xcrun stapler staple` so a copy opens offline too. Runs only when `PAKO_NOTARY_PROFILE` is set.
4. `dmg.sh`, then `notarize.sh Pako-<version>.dmg`: the disk image gets its own ticket, stapled, and its `.sha256` is written again.
5. `release-check.sh`: mounts the dmg, runs the server from it, and asks Gatekeeper (`spctl -a -vv`), which must say
   `source=Notarized Developer ID`.
6. `feed.sh` and `feed-sign.ts`: the update feed, with the checksum of the stapled dmg.

To check a result by hand:

```sh
xcrun stapler validate dist/release/Pako-<version>.dmg
spctl -a -vv -t open --context context:primary-signature dist/release/Pako-<version>.dmg
spctl -a -vv -t exec dist/release/Pako.app
```

## After the first notarized release

- Remove the **Open Anyway** steps from `README.md` ("Install"), `site/index.html` (the Mac tab) and `docs/desktop-mac.md` (step 3), and
  the "not notarized" lines in `docs/status.md` and `docs/features.md`. `test/install-docs.test.ts` checks those steps are there today:
  change it in the same commit.
- The app's signature changes from ad hoc to your Developer ID, so macOS may ask once more for Calendars, Contacts and Automation (Mail)
  after that update. Say so in the release notes.
- Keep the bundle identifier as it is: the app's stored data, its login item and its notarization history are tied to it.
