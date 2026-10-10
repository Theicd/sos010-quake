/**
 * Two-browser P2P smoke test for SOS Quake.
 * Usage: node qa/two-player-p2p.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8765/';
const WAIT_MS = 45_000;

function sleep( ms ) {

	return new Promise( ( r ) => setTimeout( r, ms ) );

}

async function waitFor( page, pred, label, timeout = WAIT_MS ) {

	const start = Date.now();
	while ( Date.now() - start < timeout ) {

		const v = await page.evaluate( pred );
		if ( v ) return v;
		await sleep( 500 );

	}

	throw new Error( `timeout waiting for ${ label }` );

}

async function debug( page ) {

	return page.evaluate( () => ( typeof window.__sosQuakeDebug === 'function' ? window.__sosQuakeDebug() : null ) );

}

async function main() {

	const browser = await chromium.launch( { headless: true } );
	// Same context = same localStorage/BroadcastChannel (two tabs). Cross-device uses Nostr.
	const ctx = await browser.newContext();
	const a = await ctx.newPage();
	const b = await ctx.newPage();

	console.log( 'base', BASE );
	await a.goto( BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 } );
	await b.goto( BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 } );

	await waitFor( a, () => !! document.getElementById( 'sos-quake-play' ), 'play button A' );
	await waitFor( b, () => !! document.getElementById( 'sos-quake-play' ), 'play button B' );
	// Wait for engine + pak
	await waitFor( a, () => typeof window.__sosQuakeDebug === 'function' && window.sv != null, 'engine A', 90_000 );
	await waitFor( b, () => typeof window.__sosQuakeDebug === 'function' && window.sv != null, 'engine B', 90_000 );

	console.log( 'click Play A' );
	await a.click( '#sos-quake-play' );
	await sleep( 1200 );
	console.log( 'click Play B' );
	await b.click( '#sos-quake-play' );

	const deadline = Date.now() + WAIT_MS;
	let lastA = null;
	let lastB = null;
	while ( Date.now() < deadline ) {

		lastA = await debug( a );
		lastB = await debug( b );
		const activeA = ( lastA?.clients || [] ).filter( ( c ) => c.active ).length;
		const activeB = ( lastB?.clients || [] ).filter( ( c ) => c.active ).length;
		console.log( JSON.stringify( {
			a: { role: lastA?.role, peers: lastA?.peers, signon: lastA?.signon, active: activeA, sv: lastA?.svActive },
			b: { role: lastB?.role, peers: lastB?.peers, signon: lastB?.signon, active: activeB, sv: lastB?.svActive },
		} ) );

		const host = lastA?.role === 'host' ? lastA : lastB?.role === 'host' ? lastB : null;
		const client = lastA?.role === 'client' ? lastA : lastB?.role === 'client' ? lastB : null;
		const hostActive = ( host?.clients || [] ).filter( ( c ) => c.active ).length;
		const hostSpawned = ( host?.clients || [] ).filter( ( c ) => c.active && c.spawned ).length;
		if (
			host && client
			&& host.peers >= 1
			&& hostActive >= 2
			&& hostSpawned >= 2
			&& client.signon >= 4
		) {

			console.log( 'PASS: shared session — 2 spawned on host, client signon complete', {
				hostActive, hostSpawned, clientSignon: client.signon,
			} );
			await browser.close();
			process.exit( 0 );

		}

		await sleep( 1500 );

	}

	console.error( 'FAIL final', { lastA, lastB } );
	await browser.close();
	process.exit( 1 );

}

main().catch( ( e ) => {

	console.error( e );
	process.exit( 1 );

} );
