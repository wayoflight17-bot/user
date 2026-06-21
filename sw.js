/*
 * sw.js — minimal Service Worker used ONLY to show a system-level notification when a student
 * leaves an active exam (screen off, incoming call, app switch) and to close that notification
 * again once they return in time.
 *
 * IMPORTANT — what this file is NOT responsible for:
 * The actual 15-second countdown, the Page Visibility detection, and the pass/fail decision all
 * live in the main page's JavaScript (user_portal.html), using a wall-clock deadline that is
 * checked the moment the page becomes visible again. That logic works correctly with or without
 * this Service Worker. A Service Worker cannot run an accurate background timer — browsers
 * suspend idle workers within seconds — and it has no access to document.visibilityState at all
 * (there is no `document` inside a worker). Its only real job here is the one thing the page
 * itself cannot do once the user has switched to a completely different app: show a real,
 * system-level notification outside the browser.
 *
 * Deployment: this file must sit in the same folder as user_portal.html (or otherwise be served
 * such that its scope covers the page registering it). Service Worker registration requires
 * HTTPS (or localhost for local testing) — it will silently fail to register over plain HTTP on
 * a real domain, which is expected browser behavior, not a bug in this file.
 */

const NOTIFICATION_TAG = 'exam-grace-period';

self.addEventListener('install', (event) => {
    // Activate this worker as soon as it's installed, without waiting for old tabs to close.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Take control of any already-open page immediately, so a notification can be requested
    // right away without needing a page reload first.
    event.waitUntil(self.clients.claim());
});

// The page sends a postMessage() to this worker (via its registration's active worker) when it
// wants a notification shown or cleared. We keep this worker intentionally simple — no caching,
// no offline support, no push subscriptions — it only exists for this one feature.
self.addEventListener('message', (event) => {
    const data = event.data || {};

    if (data.type === 'SHOW_GRACE_NOTIFICATION') {
        const title = data.title || 'Return to your exam';
        const body = data.body || 'You have 15 seconds to return before your exam is automatically submitted.';
        event.waitUntil(
            self.registration.showNotification(title, {
                body,
                tag: NOTIFICATION_TAG,       // re-using the same tag replaces any previous one
                renotify: true,               // re-alert (vibrate/sound) even if a previous one is still showing
                requireInteraction: true,     // stays visible until the user acts, doesn't auto-dismiss
                icon: data.icon || 'logo.jpeg',
                badge: data.icon || 'logo.jpeg',
                vibrate: [200, 100, 200],
                data: { url: data.url || '/' }
            })
        );
    }

    if (data.type === 'CLEAR_GRACE_NOTIFICATION') {
        event.waitUntil(
            self.registration.getNotifications({ tag: NOTIFICATION_TAG }).then((notifications) => {
                notifications.forEach((n) => n.close());
            })
        );
    }
});

// Tapping the notification should bring the exam tab back into focus, which is exactly what
// "returning in time" needs — this is the one piece of UX a page-only solution cannot offer,
// since the page itself can't reach into the OS notification tray.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
            for (const client of clientsArr) {
                // Focus an already-open tab rather than opening a new one, if we can find one.
                if ('focus' in client) {
                    return client.focus();
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow(targetUrl);
            }
        })
    );
});
