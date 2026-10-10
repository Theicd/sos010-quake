// WebRTC net driver — listen-server in the browser (SOS P2P).
// Star topology: host runs the Quake server; clients talk only to the host.
// Transport mirrors the WebTransport reliable path: [len:u16le][payload].
//
// Important: message handlers are attached as soon as a channel is handed to
// this driver (before Quake binds a qsocket), so early signon bytes are not lost.

import { Con_Printf, Con_DPrintf, SZ_Clear, SZ_Write } from './common.js';
import { NET_NewQSocket } from './net_main.js';
import { NET_MAXMESSAGE, net_message, net_driverlevel } from './net.js';

const connections = new Map(); // qsocket -> RtcLink
let rtcInitialized = false;
let listening = false;

/** Client side: channel prepared by SosQuakeNet before `connect webrtc`. */
let pendingClient = null;

/** Host side: remote peers whose data channel is ready to accept. */
const pendingIncoming = [];

class RtcLink {

	constructor( pc, channel ) {

		this.pc = pc;
		this.channel = channel;
		this.connected = channel && channel.readyState === 'open';
		this.error = null;
		this.pendingMessages = [];
		this.rx = new Uint8Array( 0 );
		this._wired = false;

	}

}

function feedBytes( link, chunk ) {

	const merged = new Uint8Array( link.rx.length + chunk.length );
	merged.set( link.rx );
	merged.set( chunk, link.rx.length );
	link.rx = merged;

	while ( link.rx.length >= 2 ) {

		const length = link.rx[ 0 ] | ( link.rx[ 1 ] << 8 );
		if ( length <= 0 || length > NET_MAXMESSAGE ) {

			link.rx = new Uint8Array( 0 );
			link.connected = false;
			link.error = new Error( 'bad frame length' );
			return;

		}

		if ( link.rx.length < 2 + length ) break;

		const data = link.rx.subarray( 2, 2 + length );
		link.pendingMessages.push( { reliable: true, data: new Uint8Array( data ) } );
		link.rx = link.rx.subarray( 2 + length );

	}

}

/** Attach onmessage immediately so bytes that arrive before qsocket bind are kept. */
function wireChannel( link ) {

	if ( ! link || link._wired || ! link.channel ) return;
	link._wired = true;
	const ch = link.channel;

	ch.binaryType = 'arraybuffer';

	ch.addEventListener( 'open', () => {

		link.connected = true;

	} );

	ch.addEventListener( 'close', () => {

		link.connected = false;

	} );

	ch.addEventListener( 'error', () => {

		link.connected = false;
		link.error = new Error( 'datachannel error' );

	} );

	ch.addEventListener( 'message', ( ev ) => {

		const chunk = ev.data instanceof ArrayBuffer
			? new Uint8Array( ev.data )
			: new Uint8Array( ev.data.buffer, ev.data.byteOffset, ev.data.byteLength );
		feedBytes( link, chunk );

	} );

	if ( ch.readyState === 'open' ) link.connected = true;

}

function makeLink( pc, channel ) {

	const link = new RtcLink( pc, channel );
	wireChannel( link );
	return link;

}

function bindSocket( link, address ) {

	const sock = NET_NewQSocket();
	if ( ! sock ) {

		Con_Printf( 'RTC bindSocket: no free qsocket (maxclients/active full)\n' );
		try {

			link.pc.close();

		} catch ( e ) { /* closed */ }

		return null;

	}

	sock.address = address || 'webrtc';
	sock.driver = net_driverlevel;
	sock.driverdata = link;
	sock.lastMessageTime = performance.now() / 1000;
	connections.set( sock, link );
	Con_DPrintf( 'RTC qsocket bound (%s) queued=%d\n', sock.address, link.pendingMessages.length );
	return sock;

}

/**
 * SosQuakeNet calls this as soon as the client data channel exists (often on open).
 * Bytes are buffered immediately.
 */
export function RTC_SetPendingClient( pc, channel, address = 'webrtc-host' ) {

	if ( pendingClient?.link ) {

		// replace — close previous unused link
		try {

			pendingClient.pc.close();

		} catch ( e ) { /* closed */ }

	}

	pendingClient = { pc, channel, address, link: makeLink( pc, channel ) };

}

/**
 * SosQuakeNet calls this on the host when a remote peer's channel appears.
 * Prefer calling this from ondatachannel (not only onopen) so early bytes buffer.
 */
export function RTC_EnqueueIncoming( pc, channel, address = 'webrtc-peer' ) {

	// Avoid double-enqueue of the same channel
	for ( const item of pendingIncoming ) {

		if ( item.channel === channel ) return item.link;

	}

	for ( const link of connections.values() ) {

		if ( link.channel === channel ) return link;

	}

	const link = makeLink( pc, channel );
	pendingIncoming.push( { pc, channel, address, link } );
	return link;

}

export function RTC_ClearPendingClient() {

	pendingClient = null;

}

/**
 * Before a Quake `connect webrtc` reconnect (e.g. after fetching a BSP), keep the
 * live DataChannel across NET_Close so signon can restart without a new offer.
 */
export function RTC_ArmReconnect( sock ) {

	if ( ! sock || ! sock.driverdata ) return false;
	const link = sock.driverdata;
	link._reuse = true;
	pendingClient = {
		pc: link.pc,
		channel: link.channel,
		address: sock.address || 'webrtc',
		link,
	};
	return true;

}

export function RTC_PendingIncomingCount() {

	return pendingIncoming.length;

}

export function RTC_DebugState() {

	return {
		listening,
		pendingIncoming: pendingIncoming.length,
		hasPendingClient: !! pendingClient,
		connections: connections.size,
		queued: [ ...connections.values() ].map( ( l ) => l.pendingMessages.length ),
	};

}

export function RTC_Init() {

	if ( typeof RTCPeerConnection === 'undefined' ) {

		Con_Printf( 'WebRTC not available in this browser\n' );
		return - 1;

	}

	rtcInitialized = true;
	Con_Printf( 'WebRTC driver initialized\n' );
	return 0;

}

export function RTC_Shutdown() {

	for ( const [ sock, link ] of connections ) {

		try {

			link.channel.close();

		} catch ( e ) { /* closed */ }

		try {

			link.pc.close();

		} catch ( e ) { /* closed */ }

		void sock;

	}

	connections.clear();
	pendingClient = null;
	pendingIncoming.length = 0;
	listening = false;
	rtcInitialized = false;

}

export function RTC_Listen( state ) {

	listening = !! state;
	Con_DPrintf( 'RTC_Listen: %s\n', listening ? '1' : '0' );

}

export function RTC_SearchForHosts( /* xmit */ ) {

	// Discovery is handled by SosQuakeNet over Nostr.

}

export function RTC_Connect( host ) {

	if ( ! host || ( host !== 'webrtc' && ! String( host ).startsWith( 'webrtc:' ) ) )
		return null;

	const pending = pendingClient;
	pendingClient = null;
	if ( ! pending || ! pending.channel || ! pending.link ) {

		Con_Printf( 'RTC_Connect: no pending WebRTC channel\n' );
		return Promise.resolve( null );

	}

	return new Promise( ( resolve ) => {

		const finish = () => {

			const sock = bindSocket( pending.link, pending.address || host );
			resolve( sock );

		};

		if ( pending.channel.readyState === 'open' || pending.link.connected ) {

			finish();
			return;

		}

		const timer = setTimeout( () => {

			Con_Printf( 'RTC_Connect: channel open timeout\n' );
			resolve( null );

		}, 8000 );

		pending.channel.addEventListener( 'open', () => {

			clearTimeout( timer );
			finish();

		}, { once: true } );

	} );

}

export function RTC_CheckNewConnections() {

	if ( ! listening || pendingIncoming.length === 0 )
		return null;

	const next = pendingIncoming.shift();
	const sock = bindSocket( next.link, next.address );
	if ( sock )
		Con_Printf( 'WebRTC peer accepted (%s)\n', next.address );
	else
		Con_Printf( 'WebRTC peer rejected — no free socket\n' );

	return sock;

}

export function RTC_QGetMessage( sock ) {

	const link = sock.driverdata;
	if ( ! link ) return - 1;
	if ( ! link.connected && link.pendingMessages.length === 0 ) return - 1;

	while ( link.pendingMessages.length > 0 ) {

		const msg = link.pendingMessages.shift();
		SZ_Clear( net_message );
		SZ_Write( net_message, msg.data, msg.data.length );
		sock.lastMessageTime = performance.now() / 1000;
		return msg.reliable ? 1 : 2;

	}

	return link.connected ? 0 : - 1;

}

function sendFrame( link, data, length ) {

	if ( ! link || ! link.channel || link.channel.readyState !== 'open' )
		return - 1;

	const frame = new Uint8Array( 2 + length );
	frame[ 0 ] = length & 0xff;
	frame[ 1 ] = ( length >> 8 ) & 0xff;
	frame.set( data.subarray( 0, length ), 2 );

	try {

		link.channel.send( frame );
		link.connected = true;

	} catch ( e ) {

		Con_DPrintf( 'RTC send error: %s\n', e.message );
		link.connected = false;
		link.error = e;
		return - 1;

	}

	return 1;

}

export function RTC_QSendMessage( sock, data ) {

	const link = sock.driverdata;
	if ( ! link ) return - 1;
	if ( link.error ) {

		link.connected = false;
		return - 1;

	}

	return sendFrame( link, data.data, data.cursize );

}

export function RTC_SendUnreliableMessage( sock, data ) {

	return RTC_QSendMessage( sock, data );

}

export function RTC_CanSendMessage( sock ) {

	const link = sock.driverdata;
	return !!( link && link.channel && link.channel.readyState === 'open' && ! link.error );

}

export function RTC_CanSendUnreliableMessage( sock ) {

	return RTC_CanSendMessage( sock );

}

export function RTC_Close( sock ) {

	const link = connections.get( sock );
	connections.delete( sock );
	if ( ! link ) return;

	sock.driverdata = null;

	// Armed for reconnect — keep the RTCPeerConnection / DataChannel alive.
	if ( link._reuse ) {

		link._reuse = false;
		return;

	}

	try {

		link.channel.close();

	} catch ( e ) { /* closed */ }

	try {

		link.pc.close();

	} catch ( e ) { /* closed */ }

	link.connected = false;

}

export function RTC_GetAnyMessage() {

	return null;

}
