// SOS Quake — network-first shell so deploys show up; cache icons/pak for offline-ish relaunch.
const CACHE = 'sos-quake-v3';

self.addEventListener( 'install', ( e ) => {

	self.skipWaiting();
	e.waitUntil( ( async () => {

		try {

			const cache = await caches.open( CACHE );
			await Promise.allSettled( [
				cache.add( './' ),
				cache.add( './index.html' ),
				cache.add( './manifest.webmanifest' ),
				cache.add( './icon.png' ),
				cache.add( './icon.svg' ),
			] );

		} catch { /* first visit offline */ }

	} )() );

} );

self.addEventListener( 'activate', ( e ) => e.waitUntil( ( async () => {

	const keys = await caches.keys();
	await Promise.all( keys.filter( ( k ) => k !== CACHE ).map( ( k ) => caches.delete( k ) ) );
	await self.clients.claim();

} )() ) );

self.addEventListener( 'fetch', ( e ) => {

	const req = e.request;
	if ( req.method !== 'GET' ) return;
	const url = new URL( req.url );
	if ( url.origin !== self.location.origin ) return;

	e.respondWith( ( async () => {

		try {

			const fresh = await fetch( req );
			if ( fresh && fresh.ok && ( url.pathname.endsWith( '.png' )
				|| url.pathname.endsWith( '.svg' )
				|| url.pathname.endsWith( '.webmanifest' )
				|| url.pathname.endsWith( 'pak0.pak' ) ) ) {

				const cache = await caches.open( CACHE );
				void cache.put( req, fresh.clone() );

			}

			return fresh;

		} catch {

			const cache = await caches.open( CACHE );
			const hit = await cache.match( req );
			if ( hit ) return hit;
			if ( req.mode === 'navigate' ) {

				const index = await cache.match( './index.html' ) || await cache.match( './' );
				if ( index ) return index;

			}

			throw new Error( 'offline' );

		}

	} )() );

} );
