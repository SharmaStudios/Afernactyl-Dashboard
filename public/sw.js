// Afernactyl PWA Service Worker
// Version 2 - Fixed offline support
const CACHE_VERSION = 'v2';
const CACHE_NAME = `afernactyl-${CACHE_VERSION}`;

// Static assets to pre-cache for offline use
const STATIC_ASSETS = [
    '/',
    '/offline.html',
    '/css/style.css',
    '/manifest.json'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker v2...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                // Cache each asset individually to handle failures gracefully
                return Promise.all(
                    STATIC_ASSETS.map(asset => {
                        return cache.add(asset).catch(err => {
                            console.warn(`[SW] Failed to cache: ${asset}`, err);
                            return null; // Continue even if one asset fails
                        });
                    })
                );
            })
            .then(() => self.skipWaiting())
            .catch(err => {
                console.error('[SW] Install failed:', err);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker v2...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name.startsWith('afernactyl-') && name !== CACHE_NAME)
                    .map((name) => {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        }).then(() => {
            console.log('[SW] Taking control of clients');
            return self.clients.claim();
        })
    );
});

// Fetch event - network first, fallback to cache, then offline page
self.addEventListener('fetch', (event) => {
    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // Skip chrome-extension and other non-http requests
    if (!event.request.url.startsWith('http')) return;

    // Skip API calls - they should always go to network
    const url = new URL(event.request.url);
    if (url.pathname.startsWith('/api/')) return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Don't cache non-successful responses
                if (!response || response.status !== 200 || response.type === 'opaque') {
                    return response;
                }

                // Clone the response for caching
                const responseClone = response.clone();

                // Cache successful responses for static assets
                if (url.pathname.startsWith('/css/') ||
                    url.pathname.startsWith('/icons/') ||
                    url.pathname.startsWith('/js/') ||
                    url.pathname === '/manifest.json' ||
                    url.pathname.endsWith('.png') ||
                    url.pathname.endsWith('.jpg') ||
                    url.pathname.endsWith('.svg') ||
                    url.pathname.endsWith('.woff2')) {
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }

                return response;
            })
            .catch((error) => {
                console.log('[SW] Network request failed, trying cache:', event.request.url);

                // Network failed, try cache
                return caches.match(event.request)
                    .then((cachedResponse) => {
                        if (cachedResponse) {
                            console.log('[SW] Serving from cache:', event.request.url);
                            return cachedResponse;
                        }

                        // If it's a navigation request, show offline page
                        if (event.request.mode === 'navigate') {
                            console.log('[SW] Serving offline page');
                            return caches.match('/offline.html').then(offlineResponse => {
                                if (offlineResponse) {
                                    return offlineResponse;
                                }
                                // If offline.html not cached, return a basic offline response
                                return new Response(`
                                    <!DOCTYPE html>
                                    <html>
                                    <head>
                                        <meta charset="UTF-8">
                                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                        <title>Offline</title>
                                        <style>
                                            body { 
                                                font-family: system-ui; 
                                                background: #0a0f1c; 
                                                color: white; 
                                                display: flex; 
                                                align-items: center; 
                                                justify-content: center; 
                                                min-height: 100vh; 
                                                text-align: center;
                                            }
                                            button { 
                                                background: #6366f1; 
                                                color: white; 
                                                border: none; 
                                                padding: 1rem 2rem; 
                                                border-radius: 8px; 
                                                cursor: pointer; 
                                                margin-top: 1rem;
                                            }
                                        </style>
                                    </head>
                                    <body>
                                        <div>
                                            <h1>You're Offline</h1>
                                            <p>Please check your internet connection.</p>
                                            <button onclick="location.reload()">Retry</button>
                                        </div>
                                    </body>
                                    </html>
                                `, {
                                    headers: { 'Content-Type': 'text/html' }
                                });
                            });
                        }

                        // For other requests, return a simple offline response
                        return new Response('Offline', {
                            status: 503,
                            statusText: 'Service Unavailable'
                        });
                    });
            })
    );
});

// Handle push notifications
self.addEventListener('push', (event) => {
    if (event.data) {
        const data = event.data.json();
        const options = {
            body: data.body || 'You have a new notification',
            icon: '/icons/icon-192x192.png',
            badge: '/icons/icon-72x72.png',
            vibrate: [100, 50, 100],
            data: {
                url: data.url || '/dashboard'
            }
        };

        event.waitUntil(
            self.registration.showNotification(data.title || 'Afernactyl', options)
        );
    }
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    event.waitUntil(
        clients.openWindow(event.notification.data.url || '/dashboard')
    );
});

// Log service worker state
console.log('[SW] Service Worker loaded');
