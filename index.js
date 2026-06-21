/**
 * functions/index.js
 *
 * Cloud Functions that send real push notifications (via Firebase Cloud Messaging / the Web
 * Push protocol) whenever an admin publishes new content. This is the server-side half that
 * user_portal.html's client-side subscription code cannot provide on its own — sending a push
 * requires a private key that must never live in client-side source.
 *
 * WHAT THIS WATCHES (all under artifacts/{appId}/public/data/... to match the app's existing
 * Firestore layout):
 *   - exam_seasons     (onCreate)        -> "New season started"
 *   - exam_quizzes     (onCreate)        -> "New test published"
 *   - study_content    (onCreate)        -> "New study material posted"
 *   - exam_seasons     (onUpdate)        -> "Winners announced" (when popupShownVersion changes
 *                                            and a winner object is present — this matches
 *                                            exactly how the existing in-app winner popup logic
 *                                            in user_portal.html already detects an announcement)
 *
 * DEPLOYMENT (you, not Claude, run these — this code cannot deploy itself):
 *   1. Make sure your Firebase project is on the Blaze (pay-as-you-go) plan. Cloud Functions
 *      are not available on the free Spark plan. Triggered functions like these only bill for
 *      actual invocations (i.e. when an admin publishes something) — typical usage here costs
 *      a tiny fraction of a cent per event.
 *   2. From a terminal with the Firebase CLI installed (`npm install -g firebase-tools`) and
 *      logged in (`firebase login`), in a folder containing this `functions/` directory and a
 *      `firebase.json` (see the one provided alongside this file):
 *        cd functions
 *        npm install
 *        cd ..
 *   3. Generate a VAPID keypair (do this once):
 *        npx web-push generate-vapid-keys
 *      This prints a Public Key and a Private Key.
 *        - Public Key  -> paste into user_portal.html, replacing VAPID_PUBLIC_KEY's placeholder.
 *        - Private Key -> set as a Cloud Functions secret (NEVER put this in client-side code):
 *            firebase functions:secrets:set VAPID_PRIVATE_KEY
 *          (it will prompt you to paste the private key value)
 *        - Also set a contact email (required by the Web Push spec, used only if a push service
 *          needs to reach you about a misbehaving subscription):
 *            firebase functions:config:set vapid.email="mailto:you@example.com"
 *          ...or simpler, also as a secret:
 *            firebase functions:secrets:set VAPID_CONTACT_EMAIL
 *   4. Deploy:
 *        firebase deploy --only functions
 *   5. Test it: publish a new season/test/material from the admin panel and confirm a
 *      notification arrives on a device that has notifications enabled in the user app's
 *      profile settings.
 */

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const webpush = require('web-push');

initializeApp();
const db = getFirestore();

// --- Config ---
// Must match the appId your client app actually uses. The client falls back to
// 'way-of-light-v3' when __app_id isn't injected by its hosting environment — if you've ever
// changed that fallback in user_portal.html, update it here too so the paths line up.
const APP_ID = 'way-of-light-v3';

const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const VAPID_CONTACT_EMAIL = defineSecret('VAPID_CONTACT_EMAIL');

// IMPORTANT: this must be the exact same public key pasted into user_portal.html's
// VAPID_PUBLIC_KEY constant — they're two halves of one keypair, both have to match for any of
// this to work. Paste it here too once you've generated it.
const VAPID_PUBLIC_KEY = 'PASTE_YOUR_VAPID_PUBLIC_KEY_HERE';

const subscriptionsCol = () => db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('push_subscriptions');

/**
 * Sends one notification payload to every stored subscription, removing any that have gone
 * stale (expired/unsubscribed at the browser level — the push service tells us this via a 404
 * or 410 response, which is the standard way to detect a dead subscription).
 */
async function broadcastToAllSubscribers(payload) {
    webpush.setVapidDetails(
        `mailto:${VAPID_CONTACT_EMAIL.value() || 'admin@example.com'}`,
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY.value()
    );

    const snap = await subscriptionsCol().get();
    if (snap.empty) return { sent: 0, removed: 0 };

    let sent = 0;
    const staleDocs = [];

    await Promise.all(snap.docs.map(async (docSnap) => {
        const data = docSnap.data();
        const subscription = data.subscription;
        if (!subscription || !subscription.endpoint) return;

        try {
            await webpush.sendNotification(subscription, JSON.stringify(payload));
            sent++;
        } catch (err) {
            // 404/410 = the push service confirms this subscription no longer exists (browser
            // uninstalled, permission revoked at the OS level, etc.) — safe and correct to
            // remove it so we stop wasting sends on it.
            if (err.statusCode === 404 || err.statusCode === 410) {
                staleDocs.push(docSnap.ref);
            } else {
                console.warn(`Push failed for subscription ${docSnap.id}:`, err.statusCode, err.body);
            }
        }
    }));

    if (staleDocs.length > 0) {
        const batch = db.batch();
        staleDocs.forEach((ref) => batch.delete(ref));
        await batch.commit();
    }

    return { sent, removed: staleDocs.length };
}

// ===========================================================================
// New season started
// ===========================================================================
exports.notifyNewSeason = onDocumentCreated(
    {
        document: `artifacts/${APP_ID}/public/data/exam_seasons/{seasonId}`,
        secrets: [VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL]
    },
    async (event) => {
        const season = event.data?.data();
        if (!season) return;

        const result = await broadcastToAllSubscribers({
            title: '🏆 New Season Started!',
            body: `${season.name || 'A new season'} is live now. Jump in and start climbing the leaderboard!`,
            icon: 'logo.jpeg',
            tag: 'season',
            type: 'season',
            url: '#test'
        });
        console.log(`notifyNewSeason: sent=${result.sent} removed=${result.removed}`);
    }
);

// ===========================================================================
// New test published
// ===========================================================================
exports.notifyNewTest = onDocumentCreated(
    {
        document: `artifacts/${APP_ID}/public/data/exam_quizzes/{quizId}`,
        secrets: [VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL]
    },
    async (event) => {
        const quiz = event.data?.data();
        if (!quiz) return;

        const result = await broadcastToAllSubscribers({
            title: '📝 New Test Available',
            body: `"${quiz.title || 'A new test'}" has been published. Good luck!`,
            icon: 'logo.jpeg',
            tag: 'test-' + event.params.quizId, // unique per test, so multiple new tests can stack
            type: 'test',
            url: '#test'
        });
        console.log(`notifyNewTest: sent=${result.sent} removed=${result.removed}`);
    }
);

// ===========================================================================
// New study material posted
// ===========================================================================
exports.notifyNewStudyMaterial = onDocumentCreated(
    {
        document: `artifacts/${APP_ID}/public/data/study_content/{itemId}`,
        secrets: [VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL]
    },
    async (event) => {
        const item = event.data?.data();
        if (!item) return;

        const result = await broadcastToAllSubscribers({
            title: '📚 New Study Material',
            body: item.title ? `"${item.title}" was just posted.` : 'New study material was just posted.',
            icon: 'logo.jpeg',
            tag: 'material-' + event.params.itemId,
            type: 'material',
            url: '#study'
        });
        console.log(`notifyNewStudyMaterial: sent=${result.sent} removed=${result.removed}`);
    }
);

// ===========================================================================
// Winners announced — mirrors the exact same trigger condition the client app already uses to
// show its own in-app winner popup (see checkAndShowWinnerPopup in user_portal.html): a season
// document gaining/changing `popupShownVersion` while a `winner` object is present.
// ===========================================================================
exports.notifyWinnersAnnounced = onDocumentUpdated(
    {
        document: `artifacts/${APP_ID}/public/data/exam_seasons/{seasonId}`,
        secrets: [VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL]
    },
    async (event) => {
        const before = event.data?.before?.data();
        const after = event.data?.after?.data();
        if (!before || !after) return;

        const versionChanged = (after.popupShownVersion || 0) !== (before.popupShownVersion || 0);
        const hasWinner = !!after.winner;
        if (!versionChanged || !hasWinner) return;

        const first = after.winner.first;
        const body = first
            ? `${first.name} took 1st place in ${after.name || 'the season'}! See the full results.`
            : `Winners for ${after.name || 'the season'} have been announced!`;

        const result = await broadcastToAllSubscribers({
            title: '🥇 Winners Announced!',
            body,
            icon: 'logo.jpeg',
            tag: 'winners-' + event.params.seasonId,
            type: 'winners',
            url: '#dashboard'
        });
        console.log(`notifyWinnersAnnounced: sent=${result.sent} removed=${result.removed}`);
    }
);
