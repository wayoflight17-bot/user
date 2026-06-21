# Push Notifications — Setup Guide

This adds real push notifications for: new season started, new test published, new study
material posted, and winners announced. It has two halves:

- **Client side** (already done, in `user_portal.html` + `sw.js`) — lets a user opt in from their
  Profile settings, and displays whatever notification arrives.
- **Server side** (`functions/`) — the part that actually decides when to send one and does the
  sending. This requires deployment by you; it cannot deploy itself.

## Files in this delivery

```
user_portal.html       <- main app, includes the notification opt-in toggle
sw.js                  <- Service Worker, must sit next to user_portal.html on your server
firebase.json           <- tells the Firebase CLI where your functions live
functions/
  index.js              <- the actual notification-sending logic
  package.json           <- dependencies for the functions
```

## One-time setup

### 1. Confirm your Firebase project is on the Blaze plan
Cloud Functions require the pay-as-you-go (Blaze) plan — the free Spark plan can't run them.
Typical cost here is a small fraction of a cent per notification batch; there's no fixed monthly
fee just for having functions deployed.

### 2. Install the Firebase CLI (if you don't already have it)
```bash
npm install -g firebase-tools
firebase login
```

### 3. Generate your VAPID keypair (do this once, ever)
```bash
npx web-push generate-vapid-keys
```
This prints something like:
```
Public Key:
BBauer7f9...(a long string)

Private Key:
xK2j9f...(a different long string)
```

### 4. Put the Public Key in the client app
Open `user_portal.html`, find this line (search for `VAPID_PUBLIC_KEY`):
```js
const VAPID_PUBLIC_KEY = 'PASTE_YOUR_VAPID_PUBLIC_KEY_HERE';
```
Replace the placeholder with your real Public Key, keeping the quotes.

### 5. Put the Public Key in the function too
Open `functions/index.js`, find the same constant near the top, and paste the **same** Public Key
there as well — both sides must match, they're two halves of one keypair.

### 6. Store the Private Key as a secret (never in any file)
```bash
firebase functions:secrets:set VAPID_PRIVATE_KEY
```
Paste your Private Key when prompted. This stores it securely in Google Cloud Secret Manager —
it never touches your source code or git history.

Also set a contact email (required by the Web Push spec):
```bash
firebase functions:secrets:set VAPID_CONTACT_EMAIL
```
Paste something like `you@example.com` when prompted (without `mailto:` — the code adds that).

### 7. Install function dependencies and deploy
```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

### 8. Upload `sw.js` to your server
Make sure `sw.js` sits in the same folder as `user_portal.html` on your actual hosting — they
need to be at the same web address for registration to succeed.

## Testing it

1. Open the deployed `user_portal.html`, log in, open your Profile, and tap **Enable** under
   Push Notifications. Your browser will ask for permission — accept it.
2. From the admin panel, publish a new test (or season, or study material).
3. Within a few seconds you should get a real system notification, even if you switch to a
   different app or lock your phone.
4. To check it's not silently failing, watch the function logs:
   ```bash
   firebase functions:log
   ```

## If something doesn't work

- **No prompt for permission appears**: the VAPID key in `user_portal.html` is probably still the
  placeholder — the app deliberately refuses to try subscribing until that's filled in.
- **Notification never arrives after publishing content**: check `firebase functions:log` for
  errors. A common cause is the `APP_ID` constant near the top of `functions/index.js` not
  matching what your client app actually uses — check `user_portal.html` for its `appId` value
  and make sure they're identical.
- **It worked once, then stopped for one device**: that's expected and handled automatically —
  if a push fails because a subscription has gone stale (browser uninstalled, permission revoked
  at the OS level), the function quietly removes that subscription so it stops trying. The user
  just needs to tap Enable again next time they visit.
