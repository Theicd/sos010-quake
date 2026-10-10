// WebRTC net driver — listen-server in the browser (SOS P2P).
// Star topology: host runs the Quake server; clients talk only to the host.
//
// Same shape as Kart Royale SosNet transport:
//   ctl  — reliable ordered (signon, stringcmds, reliable game messages)
//   st   — unreliable unordered maxRetransmits:0 (clc_move + entity datagrams)
//
// Message handlers attach as soon as channels are handed over, so early signon
// bytes are not lost. Each DataChannel send() is one Quake message (atomic).

import { Con_Printf, Con_DPrintf, SZ_Clear, SZ_Write } from './common.js';
import { NET_NewQSocket } from './net_main.js';
import { NET_MAXMESSAGE, net_message, net_driverlevel } from './net.js';

const connections = new Map(); // qsocket -> RtcLink
let rtcInitialized = false;
let listening = false;

/** Client side: channels prepared by SosQuakeNet before `connect webrtc`. */
let pendingClient = null;

/** Host side: remote peers ready to accept. */
const pendingIncoming = [];

/** Drop unreliable sends when the SCTP buffer is this full (Kart uses 16KB). */
const ST_BUFFERED_LIMIT = 16 * 1024;

class RtcLink {

	constructor( pc, ctl, st = null ) {

		this.pc = pc;
		this.channel = ctl; // reliable
		this.st = st; // unreliable (may arrive later)
		this.connected = ctl && ctl.readyState === 'open';
		this.error = null;
		this.pendingMessages = [];
		this._wiredCtl = false;
		this._wiredSt = false;

	}

}

function asBytes( data ) {

	if ( data instanceof ArrayBuffer ) return new Uint8Array( data );
	if ( ArrayBuffer.isView( data ) ) {

		return new Uint8Array( data.buffer, data.byteOffset, data.byteLength );

	}

	return new Uint8Array( 0 );

}

function wireCtl( link ) {

	if ( ! link?.channel || link._wiredCtl ) return;
	link._wiredCtl = true;
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
		link.error = new Error( 'ctl datachannel error' );

	} );
	ch.addEventListener( 'message', ( ev ) => {

		const data = asBytes( ev.data );
		if ( ! data.length || data.length > NET_MAXMESSAGE ) return;
		link.pendingMessages.push( { reliable: true, data } );

	} );

	if ( ch.readyState === 'open' ) link.connected = true;

}

function wireSt( link ) {

	if ( ! link?.st || link._wiredSt ) return;
	link._wiredSt = true;
	const ch = link.st;
	ch.binaryType = 'arraybuffer';

	ch.addEventListener( 'message', ( ev ) => {

		const data = asBytes( ev.data );
		if ( ! data.length || data.length > NET_MAXMESSAGE ) return;
		link.pendingMessages.push( { reliable: false, data } );

	} );

}

function makeLink( pc, ctl, st = null ) {

	const link = new RtcLink( pc, ctl, st );
	wireCtl( link );
	wireSt( link );
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
	Con_DPrintf(
		'RTC qsocket bound (%s) ctl=%s st=%s queued=%d\n',
		sock.address,
		link.channel?.readyState,
		link.st?.readyState || 'none',
		link.pendingMessages.length,
	);
	return sock;

}

/**
 * SosQuakeNet: client channels ready (ctl required, st optional until open).
 */
export function RTC_SetPendingClient( pc, ctl, st = null, address = 'webrtc-host' ) {

	if ( pendingClient?.link && ! pendingClient.link._reuse ) {

		try {

			pendingClient.pc.close();

		} catch ( e ) { /* closed */ }

	}

	pendingClient = { pc, ctl, st, address, link: makeLink( pc, ctl, st ) };

}

/**
 * Attach the unreliable channel if it arrives after ctl was already enqueued.
 */
export function RTC_AttachUnreliable( link, st ) {

	if ( ! link || ! st ) return;
	link.st = st;
	wireSt( link );

}

/**
 * SosQuakeNet host: remote peer ctl (+ optional st) ready.
 */
export function RTC_EnqueueIncoming( pc, ctl, st = null, address = 'webrtc-peer' ) {

	for ( const item of pendingIncoming ) {

		if ( item.ctl === ctl ) {

			if ( st && ! item.link.st ) RTC_AttachUnreliable( item.link, st );
			return item.link;

		}

	}

	for ( const link of connections.values() ) {

		if ( link.channel === ctl ) {

			if ( st && ! link.st ) RTC_AttachUnreliable( link, st );
			return link;

		}

	}

	const link = makeLink( pc, ctl, st );
	pendingIncoming.push( { pc, ctl, st, address, link } );
	return link;

}

export function RTC_ClearPendingClient() {

	pendingClient = null;

}

/**
 * Keep the live DataChannel(s) across NET_Close for BSP-fetch reconnect.
 */
export function RTC_ArmReconnect( sock ) {

	if ( ! sock || ! sock.driverdata ) return false;
	const link = sock.driverdata;
	link._reuse = true;
	pendingClient = {
		pc: link.pc,
		ctl: link.channel,
		st: link.st,
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
		channels: [ ...connections.values() ].map( ( l ) => ( {
			ctl: l.channel?.readyState || null,
			st: l.st?.readyState || null,
			queued: l.pendingMessages.length,
			bufSt: l.st ? l.st.bufferedAmount : null,
		} ) ),
	};

}

export function RTC_Init() {

	if ( typeof RTCPeerConnection === 'undefined' ) {

		Con_Printf( 'WebRTC not available in this browser\n' );
		return - 1;

	}

	rtcInitialized = true;
	Con_Printf( 'WebRTC driver initialized (ctl+st like Kart)\n' );
	return 0;

}

export function RTC_Shutdown() {

	for ( const [ sock, link ] of connections ) {

		try {

			link.channel?.close();

		} catch ( e ) { /* closed */ }

		try {

			link.st?.close();

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

	// Discovery is handled by SosQuakeNet over Nostr / BroadcastChannel.

}

export function RTC_Connect( host ) {

	if ( ! host || ( host !== 'webrtc' && ! String( host ).startsWith( 'webrtc:' ) ) )
		return null;

	const pending = pendingClient;
	pendingClient = null;
	if ( ! pending || ! pending.ctl || ! pending.link ) {

		Con_Printf( 'RTC_Connect: no pending WebRTC channel\n' );
		return Promise.resolve( null );

	}

	// st may still be negotiating — attach when open.
	if ( pending.st && ! pending.link.st ) RTC_AttachUnreliable( pending.link, pending.st );

	return new Promise( ( resolve ) => {

		const finish = () => {

			const sock = bindSocket( pending.link, pending.address || host );
			resolve( sock );

		};

		if ( pending.ctl.readyState === 'open' || pending.link.connected ) {

			finish();
			return;

		}

		const timer = setTimeout( () => {

			Con_Printf( 'RTC_Connect: channel open timeout\n' );
			resolve( null );

		}, 8000 );

		pending.ctl.addEventListener( 'open', () => {

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
		Con_Printf( 'WebRTC peer accepted (%s) st=%s\n', next.address, next.link.st ? 'yes' : 'no' );
	else
		Con_Printf( 'WebRTC peer rejected — no free socket\n' );

	return sock;

}

export function RTC_QGetMessage( sock ) {

	const link = sock.driverdata;
	if ( ! link ) return - 1;
	if ( ! link.connected && link.pendingMessages.length === 0 ) return - 1;

	while ( link.pendingMessages.length > 0 ) {

		let msg = link.pendingMessages.shift();

		// Unreliable: keep only the newest packet (same as WT / Quake datagrams).
		if ( msg.reliable === false ) {

			while ( link.pendingMessages.length > 0 ) {

				const next = link.pendingMessages[ 0 ];
				if ( next.reliable ) break;
				link.pendingMessages.shift();
				msg = next;

			}

		}

		SZ_Clear( net_message );
		SZ_Write( net_message, msg.data, msg.data.length );
		sock.lastMessageTime = performance.now() / 1000;
		return msg.reliable ? 1 : 2;

	}

	return link.connected ? 0 : - 1;

}

function sendOn( ch, data, length ) {

	if ( ! ch || ch.readyState !== 'open' ) return - 1;
	if ( ch.bufferedAmount > ST_BUFFERED_LIMIT ) return 0; // still valid, try later

	try {

		ch.send( data.subarray( 0, length ) );
		return 1;

	} catch ( e ) {

		Con_DPrintf( 'RTC send error: %s\n', e.message );
		return - 1;

	}

}

export function RTC_QSendMessage( sock, data ) {

	const link = sock.driverdata;
	if ( ! link ) return - 1;
	if ( link.error ) {

		link.connected = false;
		return - 1;

	}

	const r = sendOn( link.channel, data.data, data.cursize );
	if ( r === 1 ) link.connected = true;
	if ( r === - 1 ) {

		link.connected = false;
		link.error = new Error( 'ctl send failed' );

	}

	return r;

}

export function RTC_SendUnreliableMessage( sock, data ) {

	const link = sock.driverdata;
	if ( ! link ) return - 1;

	// Prefer Kart-style unreliable channel; fall back to ctl if st is not up yet.
	const ch = ( link.st && link.st.readyState === 'open' ) ? link.st : link.channel;
	const r = sendOn( ch, data.data, data.cursize );
	if ( r === - 1 && ch === link.st ) {

		// st failed — try ctl once
		return sendOn( link.channel, data.data, data.cursize );

	}

	return r;

}

export function RTC_CanSendMessage( sock ) {

	const link = sock.driverdata;
	return !!(
		link
		&& link.channel
		&& link.channel.readyState === 'open'
		&& ! link.error
		&& link.channel.bufferedAmount <= ST_BUFFERED_LIMIT
	);

}

export function RTC_CanSendUnreliableMessage( sock ) {

	const link = sock.driverdata;
	if ( ! link ) return false;
	const ch = ( link.st && link.st.readyState === 'open' ) ? link.st : link.channel;
	return !!( ch && ch.readyState === 'open' && ch.bufferedAmount <= ST_BUFFERED_LIMIT );

}

export function RTC_Close( sock ) {

	const link = connections.get( sock );
	connections.delete( sock );
	if ( ! link ) return;

	sock.driverdata = null;

	if ( link._reuse ) {

		link._reuse = false;
		return;

	}

	try {

		link.channel?.close();

	} catch ( e ) { /* closed */ }

	try {

		link.st?.close();

	} catch ( e ) { /* closed */ }

	try {

		link.pc.close();

	} catch ( e ) { /* closed */ }

	link.connected = false;

}

export function RTC_GetAnyMessage() {

	return null;

}
