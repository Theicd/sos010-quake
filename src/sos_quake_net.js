/**
 * SOS Quake quick-play — same shape as Kart Royale SosNet:
 * Nostr discovery + NIP-44 signalling + WebRTC data channel.
 * One Play tap: join an open hall (max 4) or host.
 * Modes: Deathmatch (FFA) or Team (coop vs monsters).
 * Late joiners spawn next to whoever is already on the map.
 */

import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';

import { Cbuf_AddText } from './cmd.js';
import { Con_Printf } from './common.js';
import { SCR_BeginLoadingPlaque } from './gl_screen.js';
import { set_key_dest, key_game } from './keys.js';
import { M_ForceCloseMenu } from './menu.js';
import {
	RTC_SetPendingClient,
	RTC_EnqueueIncoming,
	RTC_AttachUnreliable,
	RTC_ClearPendingClient,
	RTC_DebugState,
} from './net_webrtc.js';
import { sv, svs } from './server.js';
import { cls } from './client.js';
import { SV_LinkEdict } from './world.js';
import { VectorCopy } from './mathlib.js';
import { COM_EnsureFile } from './pak.js';

export const ROOM_TAG = 'sos_quake_v2';
const KIND_ROOM = 33214;
const KIND_SIGNAL = 25214;
const UPSTREAM_GITHUB = 'https://github.com/mrdoob/three-quake';
const MODE_DM = 'dm';
const MODE_TEAM = 'team';
const RELAYS = [
	'wss://relay.damus.io',
	'wss://nos.lol',
	'wss://relay.primal.net',
	'wss://relay.snort.social',
];

const ICE = [
	{ urls: [ 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302' ] },
	{ urls: 'stun:stun.cloudflare.com:3478' },
	{
		urls: [ 'turn:freeturn.net:3478', 'turn:freeturn.net:3478?transport=tcp' ],
		username: 'free',
		credential: 'free',
	},
	{ urls: 'turns:freeturn.net:5349', username: 'free', credential: 'free' },
];

const RTC_CONFIG = {
	iceServers: ICE,
	iceTransportPolicy: new URLSearchParams( location.search ).get( 'relay' ) === '1' ? 'relay' : 'all',
};

const MAX_HUMANS = 4;
const ROOM_TTL = 45;
const HEARTBEAT_MS = 3_000;
const ANNOUNCE_GAP_MS = 1_500;
const LISTEN_MS = 3_500;
const JOIN_TIMEOUT_MS = 14_000;
const ICE_WAIT_MS = 4_000;
const DEFAULT_MAP = 'rapture1';
/** Community deathmatch maps shipped under /maps. */
const DM_MAPS = [ 'rapture1', 'spinev2', 'naked5', 'zed', 'efdm9', 'baldm6', 'edc', 'ultrav' ];
/** Shareware episode maps for Team / coop. */
const TEAM_MAPS = [ 'start', 'e1m1', 'e1m2', 'e1m3', 'e1m4', 'e1m5', 'e1m6', 'e1m7', 'e1m8' ];
/** Extra wait (0–2.5s) so two Play presses don't both become host. */
const HOST_STAGGER_MAX_MS = 2_500;
const BUS_NAME = 'sos_quake_v2_bus';
const LS_ROOM_KEY = 'sos_quake_v2_rooms';
const LS_MODE_KEY = 'sos.quake.mode';

const now = () => Date.now();
const nowSec = () => Math.floor( now() / 1000 );
const randId = () => Math.random().toString( 36 ).slice( 2, 10 );

function waitIce( pc ) {

	if ( pc.iceGatheringState === 'complete' ) return Promise.resolve();
	return new Promise( ( resolve ) => {

		const done = () => {

			pc.removeEventListener( 'icegatheringstatechange', onChange );
			clearTimeout( timer );
			resolve();

		};
		const onChange = () => {

			if ( pc.iceGatheringState === 'complete' ) done();

		};
		const timer = setTimeout( done, ICE_WAIT_MS );
		pc.addEventListener( 'icegatheringstatechange', onChange );

	} );

}

function netAllowed() {

	const q = new URLSearchParams( location.search );
	return q.get( 'net' ) !== '0' && typeof WebSocket !== 'undefined' && typeof RTCPeerConnection !== 'undefined';

}

function readName() {

	try {

		return localStorage.getItem( 'sos.quake.name' )?.trim().slice( 0, 15 ) || 'Marine';

	} catch {

		return 'Marine';

	}

}

function mapFromQuery() {

	const m = new URLSearchParams( location.search ).get( 'map' );
	return m && /^[a-z0-9_]+$/i.test( m ) ? m : null;

}

function pickRandomMap( mode ) {

	const forced = mapFromQuery();
	if ( forced ) return forced;
	const pool = mode === MODE_TEAM ? TEAM_MAPS : DM_MAPS;
	return pool[ Math.floor( Math.random() * pool.length ) ] || DEFAULT_MAP;

}

function readMode() {

	try {

		const q = new URLSearchParams( location.search ).get( 'mode' );
		if ( q === 'team' || q === 'coop' ) return MODE_TEAM;
		if ( q === 'dm' || q === 'deathmatch' ) return MODE_DM;
		const stored = localStorage.getItem( LS_MODE_KEY );
		if ( stored === MODE_TEAM || stored === MODE_DM ) return stored;

	} catch { /* private mode */ }

	return MODE_DM;

}

function isStandalone() {

	try {

		return matchMedia( '(display-mode: fullscreen), (display-mode: standalone)' ).matches
			|| navigator.standalone === true;

	} catch {

		return false;

	}

}

function isIOS() {

	return /iphone|ipad|ipod/i.test( navigator.userAgent )
		|| ( navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 );

}

// --------------------------------------------------------------------------- UI

const ICON_GEAR = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const ICON_DL = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>';
const ICON_GH = '<svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const CSS = `
#sos-quake-chrome {
  position: fixed; z-index: 220; inset-inline: 0; top: 0;
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: calc(10px + env(safe-area-inset-top, 0px)) 12px 0;
  pointer-events: none;
  font-family: "Segoe UI", system-ui, sans-serif;
}
#sos-quake-chrome.hide { display: none !important; }
#sos-quake-chrome a, #sos-quake-chrome button {
  pointer-events: auto; width: 44px; height: 44px; border-radius: 12px;
  display: grid; place-items: center; border: 1px solid rgba(255,255,255,.16);
  background: rgba(8, 7, 6, .62); color: #f2e6c9; cursor: pointer;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 8px 22px rgba(0,0,0,.35); text-decoration: none;
}
#sos-quake-chrome .right { display: flex; gap: 8px; }
#sos-quake-chrome button:hover, #sos-quake-chrome a:hover {
  background: rgba(30, 24, 16, .82); color: #ffe7a8;
}
#sos-quake-ui {
  position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end; pointer-events: none;
  font-family: "Segoe UI", system-ui, sans-serif; color: #f2e6c9;
  background: linear-gradient(180deg, transparent 42%, rgba(0,0,0,.72) 78%, rgba(0,0,0,.92) 100%);
}
#sos-quake-ui.hide { display: none !important; }
#sos-quake-ui .panel {
  pointer-events: auto; width: min(420px, calc(100% - 28px));
  margin: 0 14px calc(18px + env(safe-area-inset-bottom, 0px));
  padding: 18px 18px 16px;
  border: 1px solid rgba(214, 178, 98, .45);
  border-radius: 14px;
  background: rgba(12, 10, 8, .78);
  box-shadow: 0 18px 50px rgba(0,0,0,.55);
  backdrop-filter: blur(10px);
}
#sos-quake-ui .brand {
  font-size: 11px; letter-spacing: .28em; text-transform: uppercase;
  color: #d6b262; margin-bottom: 6px;
}
#sos-quake-ui .modes {
  display: flex; gap: 8px; margin: 0 0 12px;
}
#sos-quake-ui .mode {
  flex: 1; border-radius: 999px; border: 1px solid rgba(255,255,255,.16);
  background: rgba(255,255,255,.06); color: #cbb996; padding: 8px 10px;
  font: 700 12px/1.1 system-ui, sans-serif; letter-spacing: .04em; cursor: pointer;
}
#sos-quake-ui .mode.on {
  color: #1a1208; border-color: rgba(214,178,98,.7);
  background: linear-gradient(180deg, #ffe08a, #d4a43a);
}
#sos-quake-ui h1 {
  font-size: 1.55rem; line-height: 1.1; margin: 0 0 6px; font-weight: 800;
  letter-spacing: -0.02em; color: #ffe7a8;
}
#sos-quake-ui .plot {
  font-size: 13px; line-height: 1.45; color: #cbb996; margin-bottom: 14px;
}
#sos-quake-ui .status {
  min-height: 1.2em; font-size: 12px; color: #9ad0ff; margin-bottom: 10px; font-weight: 600;
}
#sos-quake-ui .row { display: flex; gap: 8px; }
#sos-quake-ui .btn {
  flex: 1; border: 0; border-radius: 11px; padding: 13px 14px; cursor: pointer;
  font-size: 15px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
  color: #1a1208; background: linear-gradient(180deg, #ffe08a, #d4a43a);
}
#sos-quake-ui .btn:disabled { opacity: .55; cursor: wait; }
#sos-quake-ui .hint { margin-top: 10px; font-size: 11px; color: #8e8168; line-height: 1.4; }
#sos-quake-lamp {
  position: fixed; z-index: 210; top: calc(10px + env(safe-area-inset-top, 0px));
  right: calc(12px + 44px + 8px + 44px + 10px);
  min-width: 28px; height: 26px; padding: 0 8px; border-radius: 999px;
  display: none; align-items: center; justify-content: center; gap: 4px;
  font: 800 12px/1 system-ui, sans-serif; color: #062312;
  background: #3aa0ff; box-shadow: 0 0 10px #3aa0ff;
}
#sos-quake-lamp.on { display: flex; background: #38d86b; box-shadow: 0 0 12px #38d86b; }
#sos-quake-lamp.search { display: flex; animation: sos-q-pulse 1.1s ease-in-out infinite; }
@keyframes sos-q-pulse { 50% { opacity: .35; } }
#sos-quake-idlg {
  position: fixed; inset: 0; z-index: 240; display: none; place-items: center; padding: 16px;
  background: rgba(4, 4, 4, .66); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  font-family: "Segoe UI", system-ui, sans-serif;
}
#sos-quake-idlg.show { display: grid; }
#sos-quake-idlg .card {
  width: min(420px, 100%); padding: 22px 22px 18px; border-radius: 18px; text-align: center;
  background: linear-gradient(180deg, rgba(28, 22, 14, .97), rgba(10, 8, 6, .97));
  border: 1px solid rgba(214, 178, 98, .45);
  box-shadow: 0 18px 50px rgba(0,0,0,.6); color: #f4efe4;
}
#sos-quake-idlg img { width: 64px; height: 64px; border-radius: 14px; }
#sos-quake-idlg h3 {
  margin: 12px 0 8px; font-size: 18px; font-weight: 900; letter-spacing: .06em;
  text-transform: uppercase; color: #ffd98a;
}
#sos-quake-idlg p { margin: 0 0 8px; color: rgba(244,239,228,.88); font: 600 14px/1.5 system-ui, sans-serif; }
#sos-quake-idlg ul {
  margin: 8px 0 16px; padding: 0; list-style: none; font-size: 13px; color: rgba(255,230,190,.82); text-align: start;
}
#sos-quake-idlg li { margin: 6px 0; padding-inline-start: 1.1em; position: relative; }
#sos-quake-idlg li::before { content: "•"; position: absolute; inset-inline-start: 0; color: #d6b262; }
#sos-quake-idlg .row { display: flex; gap: 10px; justify-content: center; }
#sos-quake-idlg button {
  flex: 1; min-height: 46px; border-radius: 999px; cursor: pointer;
  font: 900 14px/1 system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase;
}
#sos-quake-idlg .ok { border: 0; color: #2a1a06; background: linear-gradient(180deg, #ffe3a3, #f4b451); }
#sos-quake-idlg .no { border: 1px solid rgba(255,255,255,.25); color: #f4efe4; background: rgba(255,255,255,.06); }
`;

// --------------------------------------------------------------------------- net

class SosQuakeNet {

	constructor() {

		this.sk = generateSecretKey();
		this.pk = getPublicKey( this.sk );
		this.pool = new SimplePool();
		this.rooms = new Map();
		this.convKeys = new Map();
		this.seen = new Set();
		this.subs = [];
		this.peers = new Map(); // pk -> { pc, channel, sid, hostSide }
		this.role = 'idle'; // idle | searching | host | client
		this.disposed = false;
		this.heartbeat = 0;
		this.announceTimer = 0;
		this.lastAnnounce = 0;
		this.timers = [];
		this.mode = readMode();
		this.map = pickRandomMap( this.mode );
		this.ui = null;
		this.chrome = null;
		this.lamp = null;
		this.playBusy = false;
		this.bus = null;
		/** @type {Map<string, { ts: number, mode: string }>} pubkey -> hello */
		this.candidates = new Map();
		this.hostSince = 0;
		this.joining = false;
		this.deferredInstall = null;
		this._ingestRoom = this._ingestRoom.bind( this );

	}

	static supported() {

		return netAllowed();

	}

	installUi() {

		if ( document.getElementById( 'sos-quake-ui-css' ) ) return;

		try {

			globalThis.__sosQuakeNoDemoMenu = true;

		} catch { /* ignore */ }

		const style = document.createElement( 'style' );
		style.id = 'sos-quake-ui-css';
		style.textContent = CSS;
		document.head.appendChild( style );

		const chrome = document.createElement( 'div' );
		chrome.id = 'sos-quake-chrome';
		chrome.innerHTML = `
			<a id="sos-quake-github" href="${ UPSTREAM_GITHUB }" target="_blank" rel="noopener noreferrer"
				title="mrdoob / three-quake on GitHub" aria-label="Open three-quake on GitHub">${ ICON_GH }</a>
			<div class="right">
				<button type="button" id="sos-quake-download" title="Install game" aria-label="Install game">${ ICON_DL }</button>
				<button type="button" id="sos-quake-gear" title="Game options" aria-label="Game options">${ ICON_GEAR }</button>
			</div>
		`;
		document.body.appendChild( chrome );
		this.chrome = chrome;

		const root = document.createElement( 'div' );
		root.id = 'sos-quake-ui';
		root.innerHTML = `
			<div class="panel">
				<div class="brand">SOS · Three.js Quake</div>
				<div class="modes" role="group" aria-label="Game mode">
					<button type="button" class="mode" data-mode="${ MODE_DM }">Deathmatch</button>
					<button type="button" class="mode" data-mode="${ MODE_TEAM }">Team</button>
				</div>
				<h1 id="sos-quake-title">Deathmatch</h1>
				<p class="plot" id="sos-quake-plot"></p>
				<div class="status" id="sos-quake-status">Ready</div>
				<div class="row">
					<button type="button" class="btn" id="sos-quake-play">Play</button>
				</div>
				<p class="hint">No accounts. Same map session · max ${ MAX_HUMANS } players · GPL Quake / <a href="${ UPSTREAM_GITHUB }" target="_blank" rel="noopener noreferrer" style="color:#d6b262">mrdoob three-quake</a></p>
			</div>
		`;
		document.body.appendChild( root );
		this.ui = root;
		this.syncModeUi();

		const lamp = document.createElement( 'div' );
		lamp.id = 'sos-quake-lamp';
		lamp.textContent = '1';
		document.body.appendChild( lamp );
		this.lamp = lamp;

		const dlg = document.createElement( 'div' );
		dlg.id = 'sos-quake-idlg';
		document.body.appendChild( dlg );
		dlg.addEventListener( 'click', ( e ) => {

			if ( e.target === dlg ) dlg.classList.remove( 'show' );

		} );

		root.querySelector( '#sos-quake-play' ).addEventListener( 'click', () => this.play() );
		for ( const btn of root.querySelectorAll( '.mode' ) ) {

			btn.addEventListener( 'click', () => {

				if ( this.playBusy || this.role === 'host' || this.role === 'client' ) return;
				this.setMode( btn.getAttribute( 'data-mode' ) );

			} );

		}

		chrome.querySelector( '#sos-quake-gear' ).addEventListener( 'click', ( e ) => {

			e.stopPropagation();
			M_ForceCloseMenu();
			Cbuf_AddText( 'menu_options\n' );

		} );
		chrome.querySelector( '#sos-quake-download' ).addEventListener( 'click', ( e ) => {

			e.stopPropagation();
			this.openInstallDialog();

		} );
		chrome.querySelector( '#sos-quake-github' ).addEventListener( 'click', ( e ) => e.stopPropagation() );

		this.setupInstallPrompt();
		M_ForceCloseMenu();
		addEventListener( 'pagehide', () => this.leave() );

	}

	setMode( mode ) {

		const next = mode === MODE_TEAM ? MODE_TEAM : MODE_DM;
		this.mode = next;
		this.map = pickRandomMap( next );
		try {

			localStorage.setItem( LS_MODE_KEY, next );

		} catch { /* ignore */ }

		this.syncModeUi();

	}

	syncModeUi() {

		if ( ! this.ui ) return;
		const team = this.mode === MODE_TEAM;
		for ( const btn of this.ui.querySelectorAll( '.mode' ) ) {

			btn.classList.toggle( 'on', btn.getAttribute( 'data-mode' ) === this.mode );

		}

		const title = this.ui.querySelector( '#sos-quake-title' );
		const plot = this.ui.querySelector( '#sos-quake-plot' );
		if ( title ) title.textContent = team ? 'Team' : 'Deathmatch';
		if ( plot ) {

			plot.textContent = team
				? 'Tap Play — 2–4 players team up over P2P against the monsters (not each other). Join an open hall or host if empty.'
				: 'Tap Play — join up to 4 players over P2P in free-for-all, or host if the hall is empty. New arrivals drop in next to you.';

		}

	}

	setupInstallPrompt() {

		if ( 'serviceWorker' in navigator ) {

			addEventListener( 'load', () => {

				navigator.serviceWorker.register( './sw.js' ).catch( () => {} );

			} );
			navigator.serviceWorker.register( './sw.js' ).catch( () => {} );

		}

		addEventListener( 'beforeinstallprompt', ( e ) => {

			e.preventDefault();
			this.deferredInstall = e;

		} );
		addEventListener( 'appinstalled', () => {

			this.deferredInstall = null;
			document.getElementById( 'sos-quake-idlg' )?.classList.remove( 'show' );

		} );

	}

	openInstallDialog() {

		const dlg = document.getElementById( 'sos-quake-idlg' );
		if ( ! dlg ) return;

		if ( isStandalone() ) {

			dlg.innerHTML = `
				<div class="card">
					<img src="./icon.png" alt="">
					<h3>כבר מותקן</h3>
					<p>SOS Quake כבר רץ כהתקנה / אייקון במסך הבית.</p>
					<div class="row"><button type="button" class="ok">הבנתי</button></div>
				</div>`;
			dlg.querySelector( '.ok' ).onclick = () => dlg.classList.remove( 'show' );
			dlg.classList.add( 'show' );
			return;

		}

		const head = `
			<img src="./icon.png" alt="">
			<h3>התקנת המשחק</h3>
			<p>ההתקנה מוסיפה את SOS Quake כאייקון בשולחן העבודה או במסך הבית — נוח במובייל ובמחשב, בלי חנות אפליקציות.</p>
			<ul>
				<li>פותח במסך מלא, בלי סרגלי דפדפן</li>
				<li>גישה מהירה מהאייקון</li>
				<li>עובד גם בטלפון וגם במחשב</li>
			</ul>`;

		if ( this.deferredInstall ) {

			dlg.innerHTML = `<div class="card">${ head }<p>לחצו <b>התקן</b> לאישור בדפדפן.</p>
				<div class="row">
					<button type="button" class="no">לא עכשיו</button>
					<button type="button" class="ok">התקן</button>
				</div></div>`;
			dlg.querySelector( '.no' ).onclick = () => dlg.classList.remove( 'show' );
			dlg.querySelector( '.ok' ).onclick = async () => {

				dlg.classList.remove( 'show' );
				const ev = this.deferredInstall;
				this.deferredInstall = null;
				if ( ! ev ) return;
				try {

					await ev.prompt();
					await ev.userChoice;

				} catch { /* dismissed */ }

			};

		} else if ( isIOS() ) {

			dlg.innerHTML = `<div class="card">${ head }
				<p>ב־Safari: לחצו <b>Share</b> ⌒ ואז <b>Add to Home Screen</b>.</p>
				<div class="row"><button type="button" class="ok">הבנתי</button></div></div>`;
			dlg.querySelector( '.ok' ).onclick = () => dlg.classList.remove( 'show' );

		} else {

			dlg.innerHTML = `<div class="card">${ head }
				<p>בדפדפן: תפריט <b>⋮</b> / כתובת האתר → <b>Install app</b> / <b>Create shortcut</b>.</p>
				<div class="row"><button type="button" class="ok">הבנתי</button></div></div>`;
			dlg.querySelector( '.ok' ).onclick = () => dlg.classList.remove( 'show' );

		}

		dlg.classList.add( 'show' );

	}

	setStatus( text ) {

		const el = document.getElementById( 'sos-quake-status' );
		if ( el ) el.textContent = text;

	}

	setLamp( count, mode ) {

		if ( ! this.lamp ) return;
		this.lamp.textContent = String( count );
		this.lamp.classList.remove( 'on', 'search' );
		if ( mode === 'search' ) this.lamp.classList.add( 'search' );
		else if ( mode === 'on' ) this.lamp.classList.add( 'on' );

	}

	hideUi() {

		if ( this.ui ) this.ui.classList.add( 'hide' );
		if ( this.chrome ) this.chrome.classList.add( 'hide' );
		document.getElementById( 'sos-quake-idlg' )?.classList.remove( 'show' );

	}

	showUi() {

		if ( this.ui ) this.ui.classList.remove( 'hide' );
		if ( this.chrome ) this.chrome.classList.remove( 'hide' );

	}

	start() {

		this.installUi();
		M_ForceCloseMenu();
		if ( ! SosQuakeNet.supported() ) {

			this.setStatus( 'Online play unavailable — Play starts a local game' );
			return;

		}

		this.setStatus( 'Ready — tap Play' );

	}

	play() {

		if ( this.playBusy || this.role === 'host' || this.role === 'client' ) return;
		M_ForceCloseMenu();
		if ( ! SosQuakeNet.supported() ) {

			this.soloFallback();
			return;

		}

		this.playBusy = true;
		const btn = document.getElementById( 'sos-quake-play' );
		if ( btn ) btn.disabled = true;
		this.role = 'searching';
		this.setStatus( 'Looking for a room…' );
		this.setLamp( 1, 'search' );
		this.listen();
		this.candidates.set( this.pk, { ts: nowSec(), mode: this.mode } );
		this._busSend( { t: 'hello', pubkey: this.pk, ts: nowSec(), mode: this.mode } );
		this.timers.push( window.setTimeout(
			() => void this.matchmake(),
			this.liveRooms().length ? 600 : LISTEN_MS,
		) );

	}

	soloFallback() {

		this.map = pickRandomMap( this.mode );
		this.hideUi();
		M_ForceCloseMenu();
		set_key_dest( key_game );
		SCR_BeginLoadingPlaque();
		const team = this.mode === MODE_TEAM;
		Cbuf_AddText(
			`disconnect\n` +
			`maxplayers 1\n` +
			`deathmatch ${ team ? 0 : 1 }\n` +
			`coop ${ team ? 1 : 0 }\n` +
			`teamplay ${ team ? 1 : 0 }\n` +
			`map ${ this.map }\n`,
		);

	}

	// --------------------------------------------------------- discovery/net

	convKey( pk ) {

		let key = this.convKeys.get( pk );
		if ( ! key ) {

			key = nip44.getConversationKey( this.sk, pk );
			this.convKeys.set( pk, key );

		}

		return key;

	}

	_ingestRoom( pubkey, c, ts ) {

		if ( ! pubkey || pubkey === this.pk ) return;
		if ( c?.closed ) {

			this.rooms.delete( pubkey );
			this._persistLocalRooms();
			return;

		}

		const prev = this.rooms.get( pubkey );
		if ( prev && prev.ts > ts ) return;
		this.rooms.set( pubkey, {
			pubkey,
			players: Math.max( 1, Math.min( MAX_HUMANS, Number( c.players ) || 1 ) ),
			map: typeof c.map === 'string' ? c.map : DEFAULT_MAP,
			mode: c.mode === MODE_TEAM ? MODE_TEAM : MODE_DM,
			ts,
		} );
		this._persistLocalRooms();

	}

	_persistLocalRooms() {

		try {

			const cut = nowSec() - ROOM_TTL;
			const list = [ ...this.rooms.values() ].filter( ( r ) => r.ts >= cut );
			localStorage.setItem( LS_ROOM_KEY, JSON.stringify( list ) );

		} catch { /* private mode */ }

	}

	_loadLocalRooms() {

		try {

			const raw = localStorage.getItem( LS_ROOM_KEY );
			if ( ! raw ) return;
			const list = JSON.parse( raw );
			if ( ! Array.isArray( list ) ) return;
			for ( const r of list ) {

				if ( r?.pubkey ) this._ingestRoom( r.pubkey, r, Number( r.ts ) || nowSec() );

			}

		} catch { /* ignore */ }

	}

	_busSend( msg ) {

		try {

			this.bus?.postMessage( msg );

		} catch { /* ignore */ }

	}

	listen() {

		if ( this.subs.length ) return;

		this._loadLocalRooms();

		// Same-origin / multi-tab discovery (also carries SDP when Nostr is slow).
		try {

			this.bus = new BroadcastChannel( BUS_NAME );
			this.bus.onmessage = ( ev ) => {

				const data = ev?.data;
				if ( ! data || typeof data !== 'object' ) return;
				if ( data.t === 'hello' && data.pubkey && data.pubkey !== this.pk ) {

					this.candidates.set( data.pubkey, {
						ts: Number( data.ts ) || nowSec(),
						mode: data.mode === MODE_TEAM ? MODE_TEAM : MODE_DM,
					} );
					// Answer so late arrivers see us during the gather window.
					if ( this.role === 'searching' || this.role === 'host' ) {

						this._busSend( { t: 'hello', pubkey: this.pk, ts: nowSec(), mode: this.mode } );

					}

				} else if ( data.t === 'room' ) {

					this._ingestRoom( data.pubkey, data, Number( data.ts ) || nowSec() );

				} else if ( data.t === 'signal' && data.to === this.pk && data.from && data.msg ) {

					void this.onSignal( data.from, data.msg );

				}

			};

		} catch { /* BroadcastChannel unavailable */ }

		try {

			addEventListener( 'storage', ( e ) => {

				if ( e.key === LS_ROOM_KEY ) this._loadLocalRooms();

			} );

		} catch { /* ignore */ }

		// Filters MUST be an array — a bare object is not iterable in nostr-tools.
		this.subs.push( this.pool.subscribeMany(
			RELAYS,
			[ { kinds: [ KIND_ROOM ], '#t': [ ROOM_TAG ], since: nowSec() - 60 } ],
			{
				onevent: ( ev ) => {

					try {

						this._ingestRoom( ev.pubkey, JSON.parse( ev.content ), ev.created_at );

					} catch { /* ignore */ }

				},
			},
		) );

		this.subs.push( this.pool.subscribeMany(
			RELAYS,
			[ { kinds: [ KIND_SIGNAL ], '#p': [ this.pk ], since: nowSec() - 10 } ],
			{
				onevent: ( ev ) => {

					if ( this.seen.has( ev.id ) ) return;
					this.seen.add( ev.id );
					let msg;
					try {

						msg = JSON.parse( nip44.decrypt( ev.content, this.convKey( ev.pubkey ) ) );

					} catch {

						return;

					}

					void this.onSignal( ev.pubkey, msg );

				},
			},
		) );

	}

	signal( to, msg ) {

		// Local bus first (instant for same device / two tabs).
		this._busSend( { t: 'signal', to, from: this.pk, msg } );

		const ev = finalizeEvent( {
			kind: KIND_SIGNAL,
			created_at: nowSec(),
			tags: [ [ 'p', to ], [ 't', ROOM_TAG ] ],
			content: nip44.encrypt( JSON.stringify( msg ), this.convKey( to ) ),
		}, this.sk );
		void Promise.allSettled( this.pool.publish( RELAYS, ev ) );

	}

	announce( closed = false ) {

		if ( this.role !== 'host' && ! closed ) return;
		clearTimeout( this.announceTimer );
		this.announceTimer = 0;
		const wait = closed ? 0 : this.lastAnnounce + ANNOUNCE_GAP_MS - now();
		if ( wait > 0 ) {

			this.announceTimer = window.setTimeout( () => {

				if ( ! this.disposed ) this.announce();

			}, wait );
			return;

		}

		this.lastAnnounce = now();
		const players = Math.min( MAX_HUMANS, 1 + this.peers.size );
		const payload = {
			v: 2,
			room: this.pk,
			players,
			max: MAX_HUMANS,
			map: this.map,
			mode: this.mode,
			closed: !! closed,
		};

		this._busSend( { t: 'room', pubkey: this.pk, ts: nowSec(), ...payload } );
		if ( closed ) {

			try {

				const raw = localStorage.getItem( LS_ROOM_KEY );
				const list = raw ? JSON.parse( raw ) : [];
				localStorage.setItem(
					LS_ROOM_KEY,
					JSON.stringify( ( Array.isArray( list ) ? list : [] ).filter( ( r ) => r.pubkey !== this.pk ) ),
				);

			} catch { /* ignore */ }

		} else {

			this._persistLocalRooms();
			// Also mirror self into localStorage so a late tab can see us before bus messages.
			try {

				const raw = localStorage.getItem( LS_ROOM_KEY );
				const list = raw ? JSON.parse( raw ) : [];
				const next = ( Array.isArray( list ) ? list : [] ).filter( ( r ) => r.pubkey !== this.pk );
				next.push( { pubkey: this.pk, players, map: this.map, mode: this.mode, ts: nowSec() } );
				localStorage.setItem( LS_ROOM_KEY, JSON.stringify( next ) );

			} catch { /* ignore */ }

		}

		const ev = finalizeEvent( {
			kind: KIND_ROOM,
			created_at: nowSec(),
			tags: [ [ 'd', ROOM_TAG ], [ 't', ROOM_TAG ] ],
			content: JSON.stringify( payload ),
		}, this.sk );
		void Promise.allSettled( this.pool.publish( RELAYS, ev ) );
		this.setLamp( players, closed ? '' : 'on' );

	}

	liveRooms() {

		// Only trust very fresh announcements — stale localStorage entries caused
		// mutual tryJoin loops where nobody was actually hosting.
		const cut = nowSec() - 20;
		return [ ...this.rooms.values() ]
			.filter( ( r ) =>
				r.ts >= cut
				&& r.players < MAX_HUMANS
				&& r.pubkey !== this.pk
				&& ( r.mode || MODE_DM ) === this.mode,
			)
			.sort( ( a, b ) => b.players - a.players || b.ts - a.ts );

	}

	async matchmake() {

		if ( this.disposed || this.role !== 'searching' ) return;
		this._loadLocalRooms();

		// 1) Prefer a room that is actively hosting right now.
		for ( const room of this.liveRooms() ) {

			if ( this.disposed || this.role !== 'searching' ) return;
			this.setStatus( `Joining room (${ room.players }/${ MAX_HUMANS })…` );
			if ( room.mode ) this.mode = room.mode;
			if ( await this.tryJoin( room.pubkey, room.map ) ) return;

		}

		// 2) Elect a host among Play candidates in the same mode (lowest pubkey hosts).
		const cut = nowSec() - 30;
		const alive = [ ...this.candidates.entries() ]
			.filter( ( [ , info ] ) => {

				const ts = typeof info === 'number' ? info : info?.ts;
				const mode = typeof info === 'number' ? MODE_DM : ( info?.mode || MODE_DM );
				return ts >= cut && mode === this.mode;

			} )
			.map( ( [ pk ] ) => pk )
			.sort();
		if ( ! alive.includes( this.pk ) ) alive.push( this.pk );
		alive.sort();
		const leader = alive[ 0 ];

		if ( leader !== this.pk ) {

			this.setStatus( 'Waiting for host…' );
			for ( let i = 0; i < 20; i ++ ) {

				if ( this.disposed || this.role !== 'searching' ) return;
				await new Promise( ( r ) => setTimeout( r, 400 ) );
				this._loadLocalRooms();
				const room = this.liveRooms().find( ( r ) => r.pubkey === leader )
					|| this.liveRooms()[ 0 ];
				if ( room ) {

					this.setStatus( `Joining room (${ room.players }/${ MAX_HUMANS })…` );
					if ( await this.tryJoin( room.pubkey, room.map ) ) return;

				}

			}

		}

		if ( ! this.disposed && this.role === 'searching' ) this.becomeHost();

	}

	becomeHost() {

		this.role = 'host';
		this.hostSince = now();
		const team = this.mode === MODE_TEAM;
		this.map = pickRandomMap( this.mode );
		this.setStatus( team ? `Hosting team · ${ this.map }…` : `Hosting · ${ this.map }…` );
		// Publish the hall immediately so a simultaneous Play can still join.
		this.announce();
		this.hideUi();
		M_ForceCloseMenu();
		set_key_dest( key_game );
		SCR_BeginLoadingPlaque();
		// Prefetch BSP so late joiners (and host) don't hit the async reconnect path blind.
		void COM_EnsureFile( 'maps/' + this.map + '.bsp' );
		Cbuf_AddText(
			`name "${ readName() }"\n` +
			`disconnect\n` +
			`maxplayers ${ MAX_HUMANS }\n` +
			`listen 1\n` +
			`deathmatch ${ team ? 0 : 1 }\n` +
			`coop ${ team ? 1 : 0 }\n` +
			`teamplay ${ team ? 1 : 0 }\n` +
			`map ${ this.map }\n`,
		);
		clearInterval( this.heartbeat );
		this.heartbeat = window.setInterval( () => {

			if ( this.role !== 'host' || this.disposed ) return;
			this.announce();
			void this.mergeLoneHost();

		}, HEARTBEAT_MS );
		this.playBusy = false;
		Con_Printf( 'SOS Quake: hosting %s P2P room on %s\n', team ? 'team' : 'deathmatch', this.map );

	}

	/**
	 * Two lone hosts: the higher pubkey abandons and joins the lower one
	 * (same rule as Kart Royale), so players end up in one session.
	 */
	async mergeLoneHost() {

		if ( this.role !== 'host' || this.peers.size > 0 || this.disposed || this.joining ) return;
		// Give the hall a few seconds to attract joiners before merging.
		if ( now() - this.hostSince < 6_000 ) return;
		const target = this.liveRooms().find( ( r ) => r.pubkey < this.pk );
		if ( ! target ) return;

		Con_Printf( 'SOS Quake: merging into host %s\n', target.pubkey.slice( 0, 8 ) );
		this.setStatus( 'Merging into another room…' );
		this.announce( true );
		clearInterval( this.heartbeat );
		this.role = 'searching';
		Cbuf_AddText( 'disconnect\n' );
		await new Promise( ( r ) => setTimeout( r, 400 ) );
		if ( this.disposed ) return;
		const ok = await this.tryJoin( target.pubkey, target.map || this.map );
		if ( ! ok && ! this.disposed ) {

			Con_Printf( 'SOS Quake: merge failed — hosting again\n' );
			this.becomeHost();

		}

	}

	tryJoin( hostPk, map ) {

		if ( this.joining || hostPk === this.pk ) return Promise.resolve( false );
		this.joining = true;

		return new Promise( ( resolve ) => {

			const pc = new RTCPeerConnection( RTC_CONFIG );
			const sid = randId();
			// Kart-style dual channels: ctl reliable, st unreliable movement/entities.
			const ctl = pc.createDataChannel( 'ctl', { ordered: true } );
			const st = pc.createDataChannel( 'st', { ordered: false, maxRetransmits: 0 } );
			st.binaryType = 'arraybuffer';
			const peer = { pc, ctl, st, sid, hostSide: false, pk: hostPk };
			this.peers.set( hostPk, peer );

			// Buffer Quake packets as soon as channels exist (before open).
			RTC_SetPendingClient( pc, ctl, st, 'webrtc:' + hostPk.slice( 0, 8 ) );

			let settled = false;
			const finish = ( ok ) => {

				if ( settled ) return;
				settled = true;
				this.joining = false;
				clearTimeout( timer );
				if ( ! ok ) {

					this.peers.delete( hostPk );
					RTC_ClearPendingClient();
					try {

						pc.close();

					} catch { /* closed */ }

				}

				resolve( ok );

			};

			const timer = setTimeout( () => finish( false ), JOIN_TIMEOUT_MS );
			peer.fail = () => finish( false );

			const enterGame = () => {

				if ( settled ) return;
				this.role = 'client';
				this.map = map || this.map;
				this.setStatus( 'Connected — entering game…' );
				this.hideUi();
				M_ForceCloseMenu();
				set_key_dest( key_game );
				SCR_BeginLoadingPlaque();
				const mapName = this.map;
				void COM_EnsureFile( 'maps/' + mapName + '.bsp' ).finally( () => {

					Cbuf_AddText( `name "${ readName() }"\nconnect webrtc\n` );

				} );
				this.setLamp( 2, 'on' );
				this.playBusy = false;
				finish( true );
				Con_Printf( 'SOS Quake: joined P2P host (ctl+st)\n' );

			};

			// Wait for unreliable `st` so clc_move never falls back onto ordered ctl (HOL stalls).
			const tryEnter = () => {

				if ( settled ) return;
				if ( ctl.readyState !== 'open' ) return;
				if ( st.readyState === 'open' ) {

					enterGame();
					return;

				}

			};
			ctl.addEventListener( 'open', tryEnter );
			st.addEventListener( 'open', tryEnter );
			if ( ctl.readyState === 'open' && st.readyState === 'open' ) tryEnter();
			// Fallback: start on ctl alone if st is slow (AttachUnreliable still wires it later).
			setTimeout( () => {

				if ( ! settled && ctl.readyState === 'open' ) enterGame();

			}, 2_000 );

			ctl.addEventListener( 'close', () => {

				if ( this.role === 'client' ) this.setStatus( 'Host disconnected' );

			} );

			void ( async () => {

				try {

					await pc.setLocalDescription( await pc.createOffer() );
					await waitIce( pc );
					this.signal( hostPk, {
						type: 'offer',
						sid,
						sdp: pc.localDescription?.sdp,
						name: readName(),
					} );

				} catch {

					finish( false );

				}

			} )();

		} );

	}

	async onSignal( from, msg ) {

		if ( ! msg || typeof msg !== 'object' ) return;
		const m = msg;
		if ( typeof m.type !== 'string' || typeof m.sid !== 'string' ) return;

		if ( m.type === 'offer' && typeof m.sdp === 'string' ) {

			if ( this.role !== 'host' ) {

				this.signal( from, { type: 'full', sid: m.sid } );
				return;

			}

			if ( this.peers.size >= MAX_HUMANS - 1 ) {

				this.signal( from, { type: 'full', sid: m.sid } );
				return;

			}

			if ( this.peers.has( from ) ) return;

			const pc = new RTCPeerConnection( RTC_CONFIG );
			const peer = {
				pc, ctl: null, st: null, link: null, sid: m.sid, hostSide: true, pk: from, enqueued: false,
			};
			this.peers.set( from, peer );

			const armPeer = () => {

				if ( ! peer.ctl || peer.enqueued ) return;
				// Prefer both channels so entity snapshots + moves share the unreliable path.
				if ( ! peer.st && peer.ctl.readyState !== 'open' ) return;
				peer.enqueued = true;
				peer.link = RTC_EnqueueIncoming(
					pc, peer.ctl, peer.st, 'webrtc:' + from.slice( 0, 8 ),
				);
				const markJoined = () => {

					this.announce();
					this.setStatus( `Players: ${ 1 + this.peers.size }/${ MAX_HUMANS }` );
					this.setLamp( 1 + this.peers.size, 'on' );
					Con_Printf(
						'SOS Quake: peer ready (%s) st=%s\n',
						from.slice( 0, 8 ),
						peer.st ? 'yes' : 'no',
					);

				};
				peer.ctl.addEventListener( 'open', markJoined );
				if ( peer.ctl.readyState === 'open' ) markJoined();
				peer.ctl.addEventListener( 'close', () => {

					this.dropPeer( from );
					this.announce();

				} );

			};

			pc.ondatachannel = ( e ) => {

				const ch = e.channel;
				if ( ch.label === 'ctl' ) {

					peer.ctl = ch;
					ch.binaryType = 'arraybuffer';

				} else if ( ch.label === 'st' ) {

					peer.st = ch;
					ch.binaryType = 'arraybuffer';

				} else {

					return;

				}

				if ( peer.ctl && peer.st && ! peer.enqueued ) {

					armPeer();

				} else if ( peer.enqueued && peer.st && peer.link ) {

					RTC_AttachUnreliable( peer.link, peer.st );
					Con_Printf( 'SOS Quake: peer st attached (%s)\n', from.slice( 0, 8 ) );

				} else if ( peer.ctl && ! peer.enqueued ) {

					// ctl first — wait briefly for st, then accept ctl-only.
					clearTimeout( peer._stWait );
					peer._stWait = setTimeout( () => armPeer(), 400 );

				}

			};

			setTimeout( () => {

				if ( ! peer.ctl || peer.ctl.readyState !== 'open' ) this.dropPeer( from );

			}, JOIN_TIMEOUT_MS );

			try {

				await pc.setRemoteDescription( { type: 'offer', sdp: m.sdp } );
				await pc.setLocalDescription( await pc.createAnswer() );
				await waitIce( pc );
				this.signal( from, { type: 'answer', sid: m.sid, sdp: pc.localDescription?.sdp } );

			} catch {

				this.dropPeer( from );

			}

			return;

		}

		const peer = this.peers.get( from );
		if ( ! peer || peer.sid !== m.sid || peer.hostSide ) return;

		if ( m.type === 'answer' && typeof m.sdp === 'string' ) {

			try {

				await peer.pc.setRemoteDescription( { type: 'answer', sdp: m.sdp } );

			} catch {

				peer.fail?.();

			}

		} else if ( m.type === 'full' ) {

			peer.fail?.();

		}

	}

	dropPeer( pk ) {

		const peer = this.peers.get( pk );
		if ( ! peer ) return;
		this.peers.delete( pk );
		try {

			peer.ctl?.close();

		} catch { /* closed */ }

		try {

			peer.st?.close();

		} catch { /* closed */ }

		try {

			peer.channel?.close();

		} catch { /* closed */ }

		try {

			peer.pc.close();

		} catch { /* closed */ }

	}

	leave() {

		this.announce( true );
		RTC_ClearPendingClient();
		for ( const pk of [ ...this.peers.keys() ] ) this.dropPeer( pk );
		clearInterval( this.heartbeat );
		clearTimeout( this.announceTimer );

	}

	dispose() {

		if ( this.disposed ) return;
		this.disposed = true;
		this.leave();
		for ( const t of this.timers ) clearTimeout( t );
		const subs = this.subs;
		this.subs = [];
		setTimeout( () => {

			for ( const sub of subs ) {

				try {

					sub.close();

				} catch { /* closed */ }

			}

			try {

				this.pool.close( RELAYS );

			} catch { /* closed */ }

		}, 1200 );

	}

}

let net = null;

export function SosQuake_Debug() {

	const clients = [];
	if ( svs?.clients ) {

		for ( let i = 0; i < ( svs.maxclients || 0 ); i ++ ) {

			const c = svs.clients[ i ];
			if ( ! c ) continue;
			clients.push( {
				i,
				active: !! c.active,
				spawned: !! c.spawned,
				name: c.name || '',
				addr: c.netconnection?.address || null,
			} );

		}

	}

	return {
		role: net?.role || 'none',
		mode: net?.mode || null,
		peers: net?.peers?.size || 0,
		pk: net?.pk?.slice( 0, 8 ) || null,
		map: net?.map || null,
		svActive: !! sv?.active,
		maxclients: svs?.maxclients || 0,
		clsState: cls?.state,
		signon: cls?.signon,
		clients,
		rtc: RTC_DebugState(),
	};

}

export function SosQuake_Start() {

	if ( net ) return net;
	net = new SosQuakeNet();
	net.start();

	try {

		window.__sosQuakeDebug = SosQuake_Debug;
		window.__sosQuakePlay = () => net.play();

	} catch { /* non-browser */ }

	const solo = new URLSearchParams( location.search ).get( 'solo' );
	const auto = new URLSearchParams( location.search ).get( 'auto' );
	if ( solo === '1' ) {

		net.soloFallback();

	} else if ( auto === '1' ) {

		setTimeout( () => net.play(), 400 );

	}

	return net;

}

/**
 * Called from Host_Spawn_f after a client finishes spawning.
 * Places late joiners next to an already-active player on the map.
 */
export function Sos_OnClientSpawned( client ) {

	if ( ! client || ! client.edict || ! svs?.clients ) return;

	// Only the listen-server host can relocate edicts.
	let others = 0;
	let anchor = null;
	for ( let i = 0; i < svs.maxclients; i ++ ) {

		const c = svs.clients[ i ];
		if ( ! c || ! c.active || ! c.spawned || ! c.edict ) continue;
		if ( c === client ) continue;
		others ++;
		if ( ! anchor ) anchor = c;

	}

	if ( ! anchor || others < 1 ) return;

	const src = anchor.edict.v.origin;
	const dst = client.edict.v.origin;
	const ang = anchor.edict.v.angles;
	const yaw = ( Number( ang[ 1 ] ) || 0 ) * Math.PI / 180;
	const offset = [
		Number( src[ 0 ] ) + Math.cos( yaw ) * 48 + ( Math.random() - 0.5 ) * 24,
		Number( src[ 1 ] ) + Math.sin( yaw ) * 48 + ( Math.random() - 0.5 ) * 24,
		Number( src[ 2 ] ) + 8,
	];
	VectorCopy( offset, dst );
	client.edict.v.angles[ 1 ] = ang[ 1 ];
	SV_LinkEdict( client.edict, false );
	Con_Printf( 'SOS Quake: spawned joiner next to active player\n' );

}
