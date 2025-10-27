'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ==========================
// Supabase (client) bootstrap
// ==========================
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ==============
// LocalStorage IO
// ==============
const storage = {
  get<T = unknown>(k: string): T | null {
    if (typeof window === 'undefined') return null;
    try { const raw = window.localStorage.getItem(k); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
  },
  set(k: string, v: unknown) { if (typeof window !== 'undefined') try { window.localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  remove(k: string) { if (typeof window !== 'undefined') try { window.localStorage.removeItem(k); } catch {} },
};

// ====================
// Types (DB-ish shapes)
// ====================
export type Sighting = {
  id: string;
  room_id: string;
  summary: string;
  city: string;
  state: string;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  reported_at: string; // ISO
  user_name: string | null;
  media_urls?: string[] | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  vehicle_color?: string | null;
};

export type Member = {
  id: string;
  room_id: string;
  email: string | null;
  phone_e164: string | null;
  approved: boolean | null;
  email_enabled: boolean | null;
  sms_enabled: boolean | null;
};

// ======================
// Keys & constants
// ======================
const STORAGE_LAST = 'ufo:lastRoomId';
const STORAGE_DEFAULT = 'ufo:defaultRoomId';
const STORAGE_TAB = 'ufo:lastTab';

// =========
// Utilities
// =========
function getBaseUrl() {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}
function fmtLocal(dtIso?: string | null) {
  if (!dtIso) return '';
  try { return new Date(dtIso).toLocaleString(); } catch { return dtIso!; }
}
function randomId() {
  // @ts-ignore
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}
function randomAdminCode() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}
function buildStorageKey(roomId: string, filename: string) {
  const safeName = filename.replace(/\s+/g, '_');
  return `${roomId}/${randomId()}-${safeName}`;
}
function debounce<T extends (...args: any[]) => void>(fn: T, ms = 120) {
  let t: any; return (...args: Parameters<T>) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
// Convert a Date/ISO to yyyy-MM-ddTHH:mm (LOCAL timezone) for <input type="datetime-local">
function toLocalInputValue(dOrIso: Date | string) {
  const d = typeof dOrIso === 'string' ? new Date(dOrIso) : dOrIso;
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}

// ==========================
// Leaflet loader (client-only)
// ==========================
function injectLeafletCssOnce() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('leaflet-css')) return;
  const link = document.createElement('link');
  link.id = 'leaflet-css'; link.rel = 'stylesheet';
  link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
  link.crossOrigin = ''; document.head.appendChild(link);
}
async function loadLeaflet(): Promise<any> { if (typeof window === 'undefined') return null; injectLeafletCssOnce(); return await import('leaflet'); }
function mapStateKey(roomId: string) { return `ufo:mapstate:${roomId || 'none'}`; }

// NEW: geocodeAddress with map-center bias support
async function geocodeAddress(q: string, roomIdForBias?: string) {
  let near: { lat: number; lng: number } | null = null;
  try {
    if (roomIdForBias) {
      const saved = storage.get<{ lat: number; lon: number; zoom: number } | null>(mapStateKey(roomIdForBias));
      if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) {
        near = { lat: saved.lat, lng: saved.lon };
      }
    }
  } catch {}

  const r = await fetch('/api/geocode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q, near }),
  });
  if (!r.ok) throw new Error(`geocode failed: ${r.status}`);
  return (await r.json()) as { address_text?: string; lat?: number; lng?: number };
}

async function ensureMember(roomId: string, email?: string, phone_e164?: string) {
  if (!roomId || (!email && !phone_e164)) return;
  try {
    const res = await fetch('/api/members/join', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room_id: roomId, email, phone_e164 }),
    });
    await res.json().catch(() => ({}));
  } catch {}
}
async function notifyRoom(params: {
  room_id: string; title: string; notes?: string; address_text?: string | null; lat?: number | null; lng?: number | null; when_iso?: string | null;
}) {
  try {
    const res = await fetch('/api/notify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (e) { return { status: 0, json: { error: String(e) } }; }
}

// ---- Service worker / cache reset (for stale PWA builds) ----
async function resetAppCache() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }
  } finally {
    location.replace(location.pathname + location.search + location.hash);
  }
}

// =================================================================
// ---------- Hoisted child components so they don’t remount ----------
// =================================================================
function MapPane({
  roomId, points, selectedId, draft, onSelect, onMapClick, isVisible, centerReq,
}: {
  roomId: string;
  points: Sighting[];
  selectedId: string | null;
  draft?: { lat: number | null; lon: number | null };
  onSelect: (id: string) => void;
  onMapClick: (lat: number, lon: number) => void;
  isVisible: boolean;
  centerReq: number; // NEW: bump to force a center-to-draft
}) {
  // Touch panning hint for iOS/Chrome
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById('leaflet-touch-style')) return;
    const s = document.createElement('style');
    s.id = 'leaflet-touch-style';
    s.textContent = `.leaflet-container{touch-action:pan-x pan-y}`;
    document.head.appendChild(s);
  }, []);

  const mapRef = useRef<any>(null);
  const sightingsLayerRef = useRef<any | null>(null);
  const draftLayerRef = useRef<any | null>(null);
  const shouldAutofitRef = useRef(true);
  const lastCenterRef = useRef(0); // throttle auto-fit after manual center

  // Create/map init + restore last view per room
  useEffect(() => {
    let mounted = true;
    (async () => {
      const L = await loadLeaflet();
      if (!mounted || !L) return;

      if (!mapRef.current) {
        const node = document.getElementById('ufo-map');
        if (!node) return;
        const m = L.map(node, { doubleClickZoom: false }).setView([39.5, -98.35], 4);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(m);

        sightingsLayerRef.current = L.layerGroup().addTo(m);
        draftLayerRef.current = L.layerGroup().addTo(m);

        const saved = storage.get<{ lat: number; lon: number; zoom: number } | null>(mapStateKey(roomId));
        if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && Number.isFinite(saved.zoom)) {
          m.setView([saved.lat, saved.lon], saved.zoom, { animate: false });
          shouldAutofitRef.current = false;
        }

        m.on('moveend zoomend', () => {
          const c = m.getCenter(); const z = m.getZoom();
          storage.set(mapStateKey(roomId), { lat: c.lat, lon: c.lng, zoom: z });
        });

        const stopAutofit = () => { shouldAutofitRef.current = false; };
        m.on('zoomstart', stopAutofit); m.on('dragstart', stopAutofit);

        // Double click/tap to create a pin (no double-click zoom)
        m.on('dblclick', (ev: any) => {
          const { lat, lng } = ev.latlng;
          onMapClick(lat, lng);
        });

        mapRef.current = m;
        setTimeout(() => { try { m.invalidateSize(false); } catch {} }, 0);
      } else {
        const m = mapRef.current;
        const saved = storage.get<{ lat: number; lon: number; zoom: number } | null>(mapStateKey(roomId));
        if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && Number.isFinite(saved.zoom)) {
          m.setView([saved.lat, saved.lon], saved.zoom, { animate: false }); shouldAutofitRef.current = false;
        } else {
          shouldAutofitRef.current = true; m.setView([39.5, -98.35], 4, { animate: false });
        }
      }
    })();
    return () => { mounted = false; };
  }, [roomId, onMapClick]);

  // Draw sightings
  useEffect(() => {
    (async () => {
      const L = await loadLeaflet(); if (!L) return;
      const m = mapRef.current; const layer = sightingsLayerRef.current;
      if (!m || !layer) return;

      layer.clearLayers();
      const bounds = L.latLngBounds([]);

      points.forEach((p) => {
        if (p.lat == null || p.lng == null) return;
        const isSel = selectedId === p.id;
        const qEnc = encodeURIComponent(p.address_text || `${p.city}, ${p.state}` || 'Sighting');
        const apple = `https://maps.apple.com/?ll=${p.lat},${p.lng}&q=${qEnc}`;
        const gmaps = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;

        const marker = L.circleMarker([p.lat, p.lng], {
          radius: isSel ? 8 : 6,
          weight: isSel ? 2 : 1,
          color: isSel ? '#dc2626' : '#1d4ed8',
          fillColor: isSel ? '#fecaca' : '#bfdbfe',
          fillOpacity: 0.85,
        })
          .on('click', () => onSelect(p.id))
          .bindPopup(
            `<div style="font: 12px system-ui">
               <b>${(p.summary || '').replace(/</g, '&lt;')}</b><br/>
               ${p.city || ''}, ${p.state || ''}<br/>
               ${p.address_text ? (p.address_text as string).replace(/</g, '&lt;') + '<br/>' : ''}
               <span style="color:#6b7280">${fmtLocal(p.reported_at)}</span>
               <div style="margin-top:6px">
                 <a href="${apple}" target="_blank" rel="noreferrer">Apple Maps</a> •
                 <a href="${gmaps}" target="_blank" rel="noreferrer">Google Maps</a>
               </div>
             </div>`
          );

        marker.addTo(layer);
        bounds.extend([p.lat, p.lng]);
      });

      // Skip auto-fit briefly after a manual center (prevents jump back)
      const lastCenterRefAny = lastCenterRef.current || 0;
      const justCentered = Date.now() - lastCenterRefAny < 1000;
      if (shouldAutofitRef.current && bounds.isValid() && !justCentered) {
        m.fitBounds(bounds.pad(0.15), { animate: false });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, selectedId]);

  // Center on selectedId when it changes
  useEffect(() => {
    const m = mapRef.current; if (!m || !selectedId) return;
    const p = points.find(x => x.id === selectedId && x.lat != null && x.lng != null);
    if (!p) return;
    try {
      m.setView([p.lat!, p.lng!], Math.max(10, m.getZoom() || 10), { animate: true });
    } catch {}
  }, [selectedId, points]);

  // Keep map sized when visible / resized / rotated
  useEffect(() => {
    const m = mapRef.current; if (!m) return;
    const run = () => { try { m.invalidateSize(false); } catch {} };

    if (isVisible) { setTimeout(run, 0); setTimeout(run, 150); }

    const onResize = () => run();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    const node = document.getElementById('ufo-map');
    let ro: ResizeObserver | undefined;
    if (node && 'ResizeObserver' in window) { ro = new ResizeObserver(() => onResize()); ro.observe(node); }

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      if (ro) ro.disconnect();
    };
  }, [isVisible]);

  // Recover after browser chrome collapse/expand & tab visibility
  useEffect(() => {
    const m = mapRef.current; if (!m) return;
    const run = () => { try { m.invalidateSize(false); } catch {} };
    const debounced = debounce(run, 160);

    const onVisibility = () => { if (document.visibilityState === 'visible') setTimeout(run, 0); };
    const onFocus = () => setTimeout(run, 0);
    const onScroll = () => debounced();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('scroll', onScroll, { passive: true });

    if (isVisible) setTimeout(run, 300);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('scroll', onScroll);
    };
  }, [isVisible]);

  // Draw the draft pin
  useEffect(() => {
    (async () => {
      const L = await loadLeaflet(); if (!L) return;
      const layer = draftLayerRef.current; if (!layer) return;
      layer.clearLayers();
      if (draft?.lat != null && draft?.lon != null) {
        const marker = L.circleMarker([draft.lat, draft.lon], {
          radius: 7, weight: 2, color: '#16a34a', fillColor: '#bbf7d0', fillOpacity: 0.9,
        }).bindTooltip('New pin', { permanent: false });
        marker.addTo(layer);
      }
    })();
  }, [draft?.lat, draft?.lon]);

 // Center on the draft pin whenever it changes (with extra safety on mobile)
useEffect(() => {
  const m = mapRef.current;
  if (!m) return;

  const dlat = draft?.lat != null ? Number(draft.lat) : null;
  const dlon = draft?.lon != null ? Number(draft.lon) : null;
  if (dlat == null || !Number.isFinite(dlat) || dlon == null || !Number.isFinite(dlon)) return;

  try {
    shouldAutofitRef.current = false;
    const nextZoom = Math.max(14, m.getZoom?.() || 14);

    // pass 1: immediate
    m.setView([dlat, dlon], nextZoom, { animate: true });
    lastCenterRef.current = Date.now();

    // pass 2: after paint
    setTimeout(() => {
      try {
        m.setView([dlat, dlon], nextZoom, { animate: false });
        m.invalidateSize(false);
      } catch {}
    }, 120);

    // pass 3: belt-and-suspenders on slow mobile
    setTimeout(() => {
      try {
        m.invalidateSize(false);
      } catch {}
    }, 360);
  } catch {}
}, [draft?.lat, draft?.lon]);

  // NEW: also center whenever centerReq bumps (explicit command from parent)
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (draft?.lat != null && draft?.lon != null) {
      try {
        shouldAutofitRef.current = false;
        const nextZoom = Math.max(14, m.getZoom?.() || 14);
        m.setView([draft.lat, draft.lon], nextZoom, { animate: true });
        lastCenterRef.current = Date.now();
        setTimeout(() => { try { m.invalidateSize(false); } catch {} }, 150);
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerReq]);

  return (
    <div className="rounded-2xl border overflow-hidden">
      <div className="mb-3 flex items-center justify-between px-4 pt-4">
        <h3 className="font-semibold">Map</h3>
        <div className="text-xs text-gray-500">Double-tap/click to drop a pin into the Report form.</div>
      </div>
      <div
        id="ufo-map"
        className="w-full"
        style={{
          height: 'calc(var(--app-vh, 1vh) * 100)',
          minHeight: 420,
          willChange: 'transform',
          transform: 'translateZ(0)',
        }}
      />
    </div>
  );
}

function ListPane({
  sightings, loading, errorMsg, onRefresh, onEdit, onDelete, onViewOnMap,
}: {
  sightings: Sighting[]; loading: boolean; errorMsg: string | null; onRefresh: () => void;
  onEdit: (s: Sighting) => void; onDelete: (s: Sighting) => Promise<void>;
  onViewOnMap: (s: Sighting) => void;
}) {
  return (
    <div className="rounded-2xl border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">Sightings</h3>
        <div className="flex gap-2">
          <button className="rounded-md border px-3 py-1 text-sm" onClick={onRefresh}>Refresh</button>
        </div>
      </div>
      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
      {!loading && !sightings.length && <p className="text-sm text-gray-500">No sightings yet.</p>}
      <ul className="divide-y rounded-md border">
        {sightings.map((s) => (
          <li key={s.id} className="p-3 flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <div className="font-medium">{s.summary}</div>
              <div className="text-xs text-gray-500">{fmtLocal(s.reported_at)}</div>
            </div>
            <div className="text-sm text-gray-700">
              {s.city}, {s.state} {s.address_text ? `• ${s.address_text}` : ''}
            </div>
            {(s.vehicle_make || s.vehicle_model || s.vehicle_color) && (
              <div className="text-xs text-gray-600">
                Vehicle: {[s.vehicle_color, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ')}
              </div>
            )}

            {s.media_urls && s.media_urls.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-1">
                {s.media_urls.map((u, i) =>
                  /\.(mp4|mov|webm|m4v)$/i.test(u) ? (
                    <video key={i} src={u} className="h-24 rounded-md border" controls />
                  ) : (
                    <a key={i} href={u} target="_blank" rel="noreferrer">
                      <img src={u} alt={`media-${i}`} className="h-24 rounded-md border" />
                    </a>
                  )
                )}
              </div>
            )}

            <div className="mt-2 flex items-center gap-2">
              <button className="rounded-md border px-2 py-1 text-xs" onClick={() => onEdit(s)}>Edit</button>
              <button className="rounded-md border px-2 py-1 text-xs text-red-700" onClick={() => onDelete(s)}>Delete</button>
              <button className="rounded-md border px-2 py-1 text-xs" onClick={() => onViewOnMap(s)}>View on map</button>
              {s.lat != null && s.lng != null && (
                <div className="ml-auto text-xs text-gray-500">{s.lat.toFixed(5)}, {s.lng.toFixed(5)}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShareLink({ roomId }: { roomId: string }) {
  const link = `${getBaseUrl()}/?room=${encodeURIComponent(roomId)}`;
  return (
    <div className="mt-3 rounded-md border p-3">
      <h3 className="font-medium mb-2">Share this room</h3>
      <div className="flex gap-2 items-center">
        <input readOnly value={link} className="flex-1 rounded-md border px-3 py-2 text-sm" onFocus={(e) => e.currentTarget.select()} />
        <button
          className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
          onClick={async () => {
            try { await navigator.clipboard.writeText(link); alert('Link copied'); }
            catch { window.prompt('Copy this link:', link); }
          }}
        >Copy</button>
      </div>
      <p className="text-xs text-gray-500 mt-2">Anyone who opens this link will auto-join this room.</p>
    </div>
  );
}

function SettingsPane({
  roomId, requireAuth, setRequireAuth,
  isDefaultRoom, toggleDefaultRoom,
  sessionEmail, joinRoomById, createRoom, leaveRoom,
  onTestNotify, onEnsureMeThenTest, onPreviewRecipients,
}: {
  roomId: string | null;
  requireAuth: boolean;
  setRequireAuth: (v: boolean) => void;
  isDefaultRoom: boolean;
  toggleDefaultRoom: () => void;
  sessionEmail: string | null;
  joinRoomById: (id: string) => Promise<void>;
  createRoom: (r: { name?: string | null; owner_email?: string | null }) => Promise<void>;
  leaveRoom: () => void;
  onTestNotify: () => Promise<void>;
  onEnsureMeThenTest: () => Promise<void>;
  onPreviewRecipients: () => Promise<void>;
}) {
  return (
    <section className="rounded-2xl border p-4 space-y-3">
      <h2 className="font-semibold">Settings</h2>

      {/* Join */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
        <input
          className="md:col-span-6 rounded-md border px-3 py-2"
          placeholder="Join by Room ID, Short Code, or Name"
          onKeyDown={async (e: any) => {
            if (e.key === 'Enter') {
              const id = (e.target as HTMLInputElement).value.trim();
              if (id) await joinRoomById(id);
              (e.target as HTMLInputElement).value = '';
            }
          }}
        />
        <button
          className="md:col-span-2 rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
          onClick={() => {
            const v = prompt('Enter Room ID, Short Code, or Name');
            if (v) void joinRoomById(v.trim());
          }}
        >
          Join
        </button>
        <div className="md:col-span-4 flex items-center justify-end">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={requireAuth} onChange={(e) => setRequireAuth(e.target.checked)} />
            Require sign-in to post
          </label>
        </div>
      </div>

      {/* Create room */}
      <div className="rounded-md border p-3">
        <h3 className="font-medium mb-2">Create a Room</h3>
        <div className="flex flex-col md:flex-row gap-2">
          <input id="new-room-name" className="rounded-md border px-3 py-2 flex-1" placeholder="Room name (optional)" />
          <button
            className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
            onClick={() => {
              const name = (document.getElementById('new-room-name') as HTMLInputElement | null)?.value || '';
              void createRoom({ name, owner_email: sessionEmail || undefined });
            }}
          >Create</button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={leaveRoom}>Leave room</button>
        </div>
        {roomId && <ShareLink roomId={roomId} />}

        {/* Default room toggle */}
        {roomId && (
          <div className="mt-3 rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={isDefaultRoom} onChange={toggleDefaultRoom} />
              Make this my default room on this device
            </label>
            <p className="text-xs text-gray-500 mt-1">You’ll auto-join this room when you open the app. You can change this anytime.</p>
          </div>
        )}
      </div>

      {/* Notifications */}
      <div className="mt-4 rounded-md border p-3">
        <h3 className="font-medium mb-2">Notifications</h3>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={onTestNotify}>Send Test Email/SMS</button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={onEnsureMeThenTest}>Ensure I’m a member, then Test</button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={onPreviewRecipients}>Preview recipients</button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={() => { if (confirm('Reset cached app files and reload?')) resetAppCache(); }}>Reset app cache</button>
        </div>
        <p className="text-xs text-gray-500 mt-2">Post at least one sighting while signed in so the app can auto-add you to <code>members</code>.</p>
      </div>

      {/* Save phone for SMS */}
      <div className="mt-4 rounded-md border p-3">
        <h3 className="font-medium mb-2">SMS alerts</h3>
        <div className="flex items-center gap-2">
          <input id="sms-phone" className="rounded-md border px-3 py-2" placeholder="+15551234567" />
          <button
            className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
            onClick={async () => {
              if (!roomId) return alert('Join or create a room first.');
              const el = document.getElementById('sms-phone') as HTMLInputElement | null;
              const phone = el?.value.trim() || '';
              if (!/^\+[1-9]\d{6,14}$/.test(phone)) return alert('Enter phone in E.164 format, e.g. +15551234567');
              const r = await fetch('/api/members/join', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, phone_e164: phone }),
              });
              const json = await r.json().catch(() => ({}));
              alert(`Saved: ${r.status}\n${JSON.stringify(json, null, 2)}`);
            }}
          >Save my number for SMS</button>
        </div>
        <p className="text-xs text-gray-500 mt-2">We’ll only text for sightings in this room.</p>
      </div>
    </section>
  );
}

function ReportPane({
  isEditing, onCancelEdit,
  summary, setSummary,
  city, setCity,
  stateCode, setStateCode,
  addressText, setAddressText,
  whenIso, setWhenIso,
  lat, setLat,
  lng, setLng,
  mediaFiles, setMediaFiles,
  fileInputRef,
  onFindAddress,
  onSave,
  onClear,
  reportAnon, setReportAnon,
  isGeocoding, isSaving,
  // NEW:
  altChoices, setAltChoices,
  setActiveTab, setCenterReq,
}: {
  isEditing: boolean; onCancelEdit: () => void;
  summary: string; setSummary: (v: string) => void;
  city: string; setCity: (v: string) => void;
  stateCode: string; setStateCode: (v: string) => void;
  addressText: string; setAddressText: (v: string) => void;
  whenIso: string; setWhenIso: (v: string) => void;
  lat: number | null; setLat: (v: number | null) => void;
  lng: number | null; setLng: (v: number | null) => void;
  mediaFiles: File[]; setMediaFiles: (v: File[]) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFindAddress: () => Promise<void>;
  onSave: () => Promise<void>;
  onClear: () => void;
  reportAnon: boolean; setReportAnon: (v: boolean) => void;
  isGeocoding: boolean; isSaving: boolean;
  // NEW:
  altChoices: Array<{ label: string; lat: number; lng: number; provider: string }>;
  setAltChoices: (v: Array<{ label: string; lat: number; lng: number; provider: string }> | ((prev: any) => any)) => void;
  setActiveTab: (t: 'map' | 'list' | 'report' | 'settings') => void;
  setCenterReq: React.Dispatch<React.SetStateAction<number>>;
}) {
  const [vehicleMake, setVehicleMake] = useState('');
  const [vehicleModel, setVehicleModel] = useState('');
  const [vehicleColor, setVehicleColor] = useState('');
  (globalThis as any).__ufoVehicle = { vehicleMake, vehicleModel, vehicleColor };

  return (
    <div className="rounded-2xl border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{isEditing ? 'Edit sighting' : 'Report a sighting'}</h3>
        {isEditing && <button className="rounded-md border px-3 py-1 text-sm" onClick={onCancelEdit}>Cancel edit</button>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm">Summary *</span>
          <input className="rounded-md border px-3 py-2" value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm">When</span>
          <input
            className="rounded-md border px-3 py-2"
            type="datetime-local"
              value={whenIso ? toLocalInputValue(whenIso) : ''}
            onChange={(e) => { const v = e.target.value; if (!v) { setWhenIso(''); return; } const local = new Date(v); setWhenIso(local.toISOString()); }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm">City *</span>
          <input className="rounded-md border px-3 py-2" value={city} onChange={(e) => setCity(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm">State *</span>
          <input className="rounded-md border px-3 py-2" value={stateCode} onChange={(e) => setStateCode(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm">Vehicle Make</span>
          <input className="rounded-md border px-3 py-2" onChange={(e) => setVehicleMake(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">Vehicle Model</span>
          <input className="rounded-md border px-3 py-2" onChange={(e) => setVehicleModel(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">Vehicle Color</span>
          <input className="rounded-md border px-3 py-2" onChange={(e) => setVehicleColor(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-sm">Place / Address</span>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border px-3 py-2"
              placeholder='Business or address (e.g. "Starbucks, Glen Cove NY" or "81 Forest Ave, Glen Cove")'
              value={addressText}
              onChange={(e) => setAddressText(e.target.value)}
            />
            <button
              className={`rounded-md border px-3 py-2 text-sm ${isGeocoding ? 'bg-gray-200 opacity-70' : 'hover:bg-gray-50'}`}
              disabled={isGeocoding}
              onClick={onFindAddress}
            >
              {isGeocoding ? 'Finding…' : 'Find Address'}
            </button>
          </div>

            <p className="text-xs text-gray-500 mt-1">
    Tip: If a business isn’t found, try its full street address. Only precise matches will drop a pin.
  </p>
{altChoices.length > 0 && (
    <div className="mt-2 rounded-lg border">
      <div className="px-3 py-2 text-xs text-gray-500">Choose a match</div>
      <ul className="max-h-56 overflow-auto divide-y">
        {altChoices.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm truncate">{c.label}</div>
              <div className="text-[11px] text-gray-500">source: {c.provider}</div>
            </div>
            <button
              className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-gray-50"
              onClick={() => {
                setLat(c.lat);
                setLng(c.lng);
                setAddressText(c.label);
                setAltChoices([]);
                setActiveTab('map');
                setCenterReq((v) => v + 1);
                setTimeout(() => setCenterReq((v) => v + 1), 140);
              }}
            >
              Use
            </button>
          </li>
        ))}
      </ul>
    </div>
  )}
          {lat != null && lng != null && (
            <p className="text-xs text-gray-500 mt-1">Pinned: {lat.toFixed(5)}, {lng.toFixed(5)}</p>
          )}
        </label>

        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-sm">Photos / Video (adding files will append)</span>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 active:bg-gray-200 select-none">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                hidden
                onChange={(e) => { const files = e.currentTarget.files ? Array.from(e.currentTarget.files) : []; setMediaFiles(files); }}
              />
              Choose files…
            </label>
            {mediaFiles.length > 0 && <span className="text-xs text-gray-600">{mediaFiles.length} selected</span>}
          </div>
        </label>

        <label className="md:col-span-2 flex items-center gap-2">
          <input type="checkbox" className="h-4 w-4" checked={reportAnon} onChange={(e) => setReportAnon(e.target.checked)} />
          <span className="text-sm">Report anonymously</span>
        </label>
      </div>

      <div className="flex gap-2">
        <button
          className={`rounded-md border px-4 py-2 ${isSaving ? 'bg-gray-200 opacity-70' : 'hover:bg-gray-50'}`}
          disabled={isSaving}
          onClick={onSave}
        >
          {isSaving ? (isEditing ? 'Updating…' : 'Saving…') : (isEditing ? 'Update sighting' : 'Save sighting')}
        </button>
        <button className="rounded-md border px-4 py-2 text-gray-700" onClick={onClear}>Clear</button>
      </div>
    </div>
  );
}

// ==================
// Component: ClientPage
// ==================
export default function ClientPage() {

  // Tabs — don't read localStorage during render (causes SSR mismatch)
const [activeTab, setActiveTab] =
  useState<'map' | 'list' | 'report' | 'settings'>('map');

// Load saved tab AFTER mount
useEffect(() => {
  const saved = storage.get(STORAGE_TAB);
  if (saved && ['map', 'list', 'report', 'settings'].includes(saved)) {
    setActiveTab(saved as any);
  }
}, []);

// Persist tab whenever it changes
useEffect(() => { storage.set(STORAGE_TAB, activeTab); }, [activeTab]);


  // Session/user
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  // Room
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [requireAuth, setRequireAuth] = useState<boolean>(true); // default ON per your request

  // Default room toggle
  const [isDefaultRoom, setIsDefaultRoom] = useState<boolean>(false);

  // Sightings + list state
  const [sightings, setSightings] = useState<Sighting[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Report form state
  const [summary, setSummary] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [addressText, setAddressText] = useState<string>('');
  const [whenIso, setWhenIso] = useState<string>('');
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [reportAnon, setReportAnon] = useState<boolean>(false);
  const [isGeocoding, setIsGeocoding] = useState(false);
  const [altChoices, setAltChoices] = useState<Array<{label:string; lat:number; lng:number; provider:string}>>([]);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // NEW: explicit center trigger for MapPane
  const [centerReq, setCenterReq] = useState(0);
  // Hydration guard: render only after we mount on the client
const [mounted, setMounted] = useState(false);
useEffect(() => { setMounted(true); }, []);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingOriginalMedia, setEditingOriginalMedia] = useState<string[] | null>(null);

  // Use a stable vh unit on mobile (handles iOS/Chrome URL bar collapse/expand)
  useEffect(() => {
    const setVH = () => { const vh = window.innerHeight * 0.01; document.documentElement.style.setProperty('--app-vh', `${vh}px`); };
    setVH(); window.addEventListener('resize', setVH); window.addEventListener('orientationchange', setVH);
    return () => { window.removeEventListener('resize', setVH); window.removeEventListener('orientationchange', setVH); };
  }, []);

  // Prompt to refresh if a new service worker (new version) is available
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg?.waiting && navigator.serviceWorker.controller) {
        if (confirm('A new version is available. Refresh now?')) resetAppCache();
      }
    });

    let unsub: (() => void) | undefined;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      const onUpdateFound = () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            if (confirm('App updated. Refresh now?')) resetAppCache();
          }
        });
      };
      reg.addEventListener?.('updatefound', onUpdateFound);
      unsub = () => reg.removeEventListener?.('updatefound', onUpdateFound);
    });

    return () => { try { unsub?.(); } catch {} };
  }, []);

  // Default the report time to "now" (local) on first load
  useEffect(() => { if (!whenIso) setWhenIso(new Date().toISOString()); /* eslint-disable-next-line */ }, []);

  // Load session/email
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!mounted) return; setSessionEmail(data.user?.email ?? null);
    })();
    const sub = supabase.auth.onAuthStateChange((_e, sess) => { setSessionEmail(sess?.user?.email ?? null); });
    return () => { mounted = false; sub.data.subscription.unsubscribe(); };
  }, []);

  // Deep-link & default/last room auto-selection
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const paramRoom = (url.searchParams.get('room') || '').trim();
    const defaultId = storage.get<string>(STORAGE_DEFAULT);
    const lastId = storage.get<string>(STORAGE_LAST);
    const envDefault = process.env.NEXT_PUBLIC_DEFAULT_ROOM_ID || null;
    const target = paramRoom || defaultId || lastId || envDefault;
    if (target && !roomId) void joinRoomById(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track/store last room and default toggle
  useEffect(() => {
    if (roomId) {
      storage.set(STORAGE_LAST, roomId);
      const curDefault = storage.get<string>(STORAGE_DEFAULT);
      setIsDefaultRoom(!!roomId && curDefault === roomId);
    } else setIsDefaultRoom(false);
  }, [roomId]);

  function toggleDefaultRoom() {
    if (!roomId) return;
    const cur = storage.get<string>(STORAGE_DEFAULT);
    if (cur === roomId) { storage.remove(STORAGE_DEFAULT); setIsDefaultRoom(false); }
    else { storage.set(STORAGE_DEFAULT, roomId); setIsDefaultRoom(true); }
  }

  // ---- Room helpers (UUID, short_code, or name) ----
  async function joinRoomById(input: string) {
    const raw = (input || '').trim();
    if (!raw) return;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
    const short = raw.toLowerCase();

    try {
      // 1) UUID
      if (isUuid) {
        const { data, error } = await supabase
          .from('rooms')
          .select('id, name')
          .eq('id', raw)
          .maybeSingle();
        if (error) return alert(`Join failed: ${error.message}`);
        if (!data) return alert('Room not found.');
        setRoomId(data.id); setRoomName(data.name || null); setSelectedId(null);
        await loadSightings(data.id);
        return;
      }

      // 2) Short code (exact)
      {
        const { data, error } = await supabase
          .from('rooms')
          .select('id, name, short_code')
          .eq('short_code', short)
          .maybeSingle();
        if (error && error.code !== 'PGRST116') { // not "No rows"
          return alert(`Join failed: ${error.message}`);
        }
        if (data) {
          setRoomId(data.id); setRoomName(data.name || null); setSelectedId(null);
          await loadSightings(data.id);
          return;
        }
      }

      // 3) Exact name (but don’t assume single row)
      {
        const { data, error } = await supabase
          .from('rooms')
          .select('id, name, short_code')
          .eq('name', raw)
          .limit(5);
        if (error) return alert(`Join failed: ${error.message}`);
        if (data && data.length === 1) {
          const r = data[0];
          setRoomId(r.id); setRoomName(r.name || null); setSelectedId(null);
          await loadSightings(r.id);
          return;
        }
        if (data && data.length > 1) {
          const pick = prompt(
            `Multiple rooms named "${raw}".\n` +
            data.map((r, i) => `${i + 1}) ${r.name || '(no name)'} — short code: ${r.short_code || 'n/a'} — id: ${r.id}`).join('\n') +
            `\n\nType a number (1-${data.length}), or paste a short code / id:`
          );
          if (!pick) return;
          const idx = Number(pick);
          if (Number.isInteger(idx) && idx >= 1 && idx <= data.length) {
            const r = data[idx - 1];
            setRoomId(r.id); setRoomName(r.name || null); setSelectedId(null);
            await loadSightings(r.id);
            return;
          }
          // user pasted something else (short code or id) — try again with that
          return joinRoomById(pick.trim());
        }
      }

      // 4) Fuzzy name (ILIKE)
      {
        const { data, error } = await supabase
          .from('rooms')
          .select('id, name, short_code')
          .ilike('name', raw) // tries case-insensitive
          .limit(5);
        if (error) return alert(`Join failed: ${error.message}`);
        if (data && data.length === 1) {
          const r = data[0];
          setRoomId(r.id); setRoomName(r.name || null); setSelectedId(null);
          await loadSightings(r.id);
          return;
        }
        if (data && data.length > 1) {
          const pick = prompt(
            `Found multiple rooms similar to "${raw}".\n` +
            data.map((r, i) => `${i + 1}) ${r.name || '(no name)'} — short code: ${r.short_code || 'n/a'} — id: ${r.id}`).join('\n') +
            `\n\nType a number (1-${data.length}), or paste a short code / id:`
          );
          if (!pick) return;
          const idx = Number(pick);
          if (Number.isInteger(idx) && idx >= 1 && idx <= data.length) {
            const r = data[idx - 1];
            setRoomId(r.id); setRoomName(r.name || null); setSelectedId(null);
            await loadSightings(r.id);
            return;
          }
          return joinRoomById(pick.trim());
        }
      }

      // Not found
      alert('Room not found. Try the room’s short code or ID.');
    } catch (e: any) {
      alert(`Join failed: ${e?.message || String(e)}`);
    }
  }

  async function createRoom(r: { name?: string | null; owner_email?: string | null }) {
    const payload = {
      name: r.name || null,
      owner_email: r.owner_email || sessionEmail || null,
      short_code: ((r.name || 'room').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 10) + '-' + Math.random().toString(36).slice(2, 6)),
      admin_code: randomAdminCode(),
    };
    const { data, error } = await supabase.from('rooms').insert(payload).select('id, name').single();
    if (error) return alert(`Create room failed: ${error.message}`);
    setRoomId(data.id); setRoomName(data.name); setSelectedId(null);
    await loadSightings(data.id);
  }
  function leaveRoom() { setRoomId(null); setRoomName(null); setSightings([]); setSelectedId(null); }

  // Sightings load / refresh
  async function loadSightings(id = roomId) {
    if (!id) return;
    setLoading(true); setErrorMsg(null);
    try {
      const { data, error } = await supabase
        .from('sightings')
        .select('id, room_id, summary, city, state, address_text, lat, lng, reported_at, user_name, media_urls, vehicle_make, vehicle_model, vehicle_color')
        .eq('room_id', id)
        .order('reported_at', { ascending: false });
      if (error) setErrorMsg(error.message);
      else setSightings((data || []) as Sighting[]);
    } catch (e: any) { setErrorMsg(e?.message || String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (roomId) void loadSightings(roomId); /* eslint-disable-next-line */ }, [roomId]);

  // Keep mobile in sync when returning to the tab/app
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible' && roomId) void loadSightings(roomId); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [roomId]);

  // Media upload
  async function uploadFilesForRoom(room: string, files: File[]): Promise<string[]> {
    if (!files.length) return [];
    const urls: string[] = [];
    for (const f of files) {
      const key = buildStorageKey(room, f.name);
      const { error } = await supabase.storage.from('sighting-photos').upload(key, f, { cacheControl: '3600', upsert: false });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      const { data: pub } = supabase.storage.from('sighting-photos').getPublicUrl(key);
      if (pub?.publicUrl) urls.push(pub.publicUrl);
    }
    return urls;
  }

  // Save / Update sighting
  async function upsertSighting() {
    if (!roomId) return alert('Join or create a room first.');
    if (requireAuth && !sessionEmail) return alert('Please sign in to post.');

    // Vehicle fields from ReportPane
    const veh = (globalThis as any).__ufoVehicle || {};
    const vehicle_make = (veh.vehicleMake || '').trim() || null;
    const vehicle_model = (veh.vehicleModel || '').trim() || null;
    const vehicle_color = (veh.vehicleColor || '').trim() || null;

    // geocode if no lat/lng
    let resolved = { address_text: addressText, lat, lng };
    if ((!lat || !lng) && (city || stateCode || addressText)) {
      try {
        const q = [addressText, city, stateCode].filter(Boolean).join(', ');
        if (q) {
          setIsGeocoding(true);
          const g = await geocodeAddress(q, roomId || undefined);
          if (g?.lat != null && g?.lng != null) {
            resolved = { address_text: g.address_text || q, lat: g.lat!, lng: g.lng! };
            setAddressText(resolved.address_text || ''); setLat(resolved.lat!); setLng(resolved.lng!);
          }
        }
      } catch {}
      finally { setIsGeocoding(false); }
    }

    const userName = reportAnon ? 'anonymous' : (sessionEmail || 'anonymous');

    // Base payload
    const base = {
      room_id: roomId,
      summary: summary.trim(),
      city: city.trim(),
      state: stateCode.trim().toUpperCase(),
      address_text: resolved.address_text || null,
      lat: resolved.lat ?? null,
      lng: resolved.lng ?? null,
      reported_at: whenIso || new Date().toISOString(),
      user_name: userName,
      vehicle_make, vehicle_model, vehicle_color,
    };

    if (!base.summary || !base.city || !base.state) return alert('City, State, and Summary are required.');

    // Require a precise pin before saving (prevents “no pin” reports)
if (base.lat == null || base.lng == null) {
  alert('Please double-tap the map or use “Find Address” to drop a pin first.');
  setActiveTab('report'); // send user back to add a pin
  return;
}


    try {
      setIsSaving(true);
      let finalMedia: string[] | null = editingId ? (editingOriginalMedia ? [...editingOriginalMedia] : null) : null;

      if (mediaFiles.length) {
        const newUrls = await uploadFilesForRoom(roomId, mediaFiles);
        finalMedia = (finalMedia || []).concat(newUrls);
      }

      if (!editingId) {
  // Return id + coords so we can jump to the pin
  const { data: created, error } = await supabase
    .from('sightings')
    .insert({ ...base, media_urls: finalMedia })
    .select('id, lat, lng')
    .single();

  if (error) return alert(`Upload failed: ${error.message}`);

  await ensureMember(roomId, sessionEmail || undefined);

  const { status: ns, json: nj } = await notifyRoom({
    room_id: roomId,
    title: base.summary.slice(0, 80) || 'New sighting',
    notes: base.summary,
    address_text: base.address_text,
    lat: base.lat,
    lng: base.lng,
    when_iso: base.reported_at,
  });
  if (ns !== 200) alert(`Notify failed (${ns}).\n${JSON.stringify(nj, null, 2)}`);

  // If the DB has lat/lng, jump straight to the Map and center there
  if (created) {
    setSelectedId(created.id);
    if (created.lat != null && created.lng != null) {
      setLat(created.lat);
      setLng(created.lng);
      setActiveTab('map');          // show the map
      setCenterReq((c) => c + 1);   // force center to this pin
    } else {
      setActiveTab('list');         // fallback if no coords
    }
  }
} else {
  const { data: updated, error } = await supabase
    .from('sightings')
    .update({ ...base, media_urls: finalMedia })
    .eq('id', editingId)
    .select('id, lat, lng')
    .single();
  if (error) return alert(`Update failed: ${error.message}`);

  // Show the map and center on the edited pin (if it has coords)
  if (updated) {
    setSelectedId(updated.id);
    if (updated.lat != null && updated.lng != null) {
      setLat(updated.lat);
      setLng(updated.lng);
      setActiveTab('map');
      setCenterReq((c) => c + 1);
    }
  }
}

     await loadSightings(roomId);
clearReportForm();
// do not force tab here; creation branch already switched to map if it had coords
    } catch (e: any) {
      alert(`Save failed: ${e?.message || String(e)}`);
    } finally {
      setIsSaving(false);
    }
  }

  function clearReportForm() {
  setEditingId(null);
  setSummary('');
  setCity('');
  setStateCode('');
  setAddressText('');
  setWhenIso(new Date().toISOString());  // ⬅️ default to “now” immediately
  setLat(null);
  setLng(null);
  setMediaFiles([]);
  setReportAnon(false);
  // If you added the candidates picker:
  try { setAltChoices([]); } catch {}
}

  async function handleDelete(s: Sighting) {
    if (!roomId) return;
    const ok = confirm('Delete this sighting? This cannot be undone.');
    if (!ok) return;
    const { error } = await supabase.from('sightings').delete().eq('id', s.id).eq('room_id', roomId);
    if (error) return alert(`Delete failed: ${error.message}`);
    await loadSightings(roomId);
  }

  function beginEdit(s: Sighting) {
    setEditingId(s.id);
    setEditingOriginalMedia(s.media_urls || null);
    setSummary(s.summary || '');
    setCity(s.city || '');
    setStateCode(s.state || '');
    setAddressText(s.address_text || '');
    setLat(s.lat ?? null); setLng(s.lng ?? null);
    setWhenIso(s.reported_at || new Date().toISOString());
    setActiveTab('report');
    (globalThis as any).__ufoVehicle = {
      vehicleMake: s.vehicle_make || '', vehicleModel: s.vehicle_model || '', vehicleColor: s.vehicle_color || '',
    };
  }

  // ---- Simple email/password auth UI (sign up & sign in) ----
  const [authEmail, setAuthEmail] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  async function doSignUp() {
    if (!authEmail || !authPass) return alert('Enter email and password');
    setAuthBusy(true);
    const { error } = await supabase.auth.signUp({ email: authEmail, password: authPass });
    setAuthBusy(false);
    alert(error ? `Sign-up error: ${error.message}` : 'Account created. You are signed in.');
  }
  async function doSignIn() {
    if (!authEmail || !authPass) return alert('Enter email and password');
    setAuthBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPass });
    setAuthBusy(false);
    alert(error ? `Sign-in error: ${error.message}` : 'Signed in.');
  }

  // ===========
  // Page header
  // ===========
  const gated = requireAuth && !sessionEmail;

  if (!mounted) return null;
  return (
    <main className="mx-auto max-w-5xl p-4 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">UFO Sightings Tracker</h1>
          <p className="text-sm text-gray-500 mt-1">
            {roomId ? <>Room: <span className="font-medium">{roomName || roomId}</span></> : <em>No room selected (open Settings)</em>}
          </p>
        </div>
        <div className="text-right">
          <div className="text-sm text-gray-700">{sessionEmail ? sessionEmail : 'Signed out'}</div>
          <div className="mt-1 flex gap-2 justify-end">
            {!sessionEmail ? (
              <>
                <input
                  className="rounded-md border px-2 py-1 text-sm"
                  placeholder="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                />
                <input
                  className="rounded-md border px-2 py-1 text-sm"
                  placeholder="password"
                  type="password"
                  value={authPass}
                  onChange={(e) => setAuthPass(e.target.value)}
                />
                <button className={`rounded-md border px-3 py-1 text-sm ${authBusy ? 'opacity-70' : ''}`} disabled={authBusy} onClick={doSignUp}>
                  {authBusy ? 'Working…' : 'Sign up'}
                </button>
                <button className={`rounded-md border px-3 py-1 text-sm ${authBusy ? 'opacity-70' : ''}`} disabled={authBusy} onClick={doSignIn}>
                  {authBusy ? 'Working…' : 'Sign in'}
                </button>
              </>
            ) : (
              <button className="rounded-md border px-3 py-1 text-sm" onClick={async () => { await supabase.auth.signOut(); }}>
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Tabs */}
      <nav className="flex gap-2">
        {(['map', 'list', 'report', 'settings'] as const).map((t) => (
          <button
            key={t}
            className={`rounded-md border px-3 py-2 text-sm ${activeTab === t ? 'bg-gray-100' : ''}`}
            onClick={() => setActiveTab(t)}
          >{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </nav>

      {/* Gate posting if required */}
      {gated && (
        <div className="rounded-xl border p-4 bg-yellow-50 text-sm">
          Posting is restricted. Please sign in above to report sightings or create rooms.
        </div>
      )}

      {/* Panels */}
      {activeTab === 'map' && (
        <MapPane
          roomId={roomId || 'none'}
          points={sightings}
          selectedId={selectedId}
          draft={{ lat: lat ?? null, lon: lng ?? null }}
          onSelect={(id) => { setSelectedId(id); setActiveTab('list'); }}
          onMapClick={async (clat, clon) => {
            setLat(clat); setLng(clon);
            try {
              const g = await geocodeAddress(`${clat}, ${clon}`, roomId || undefined);
              if (g?.address_text) setAddressText(g.address_text);
            } catch {}
            setActiveTab('report');
          }}
          isVisible={activeTab === 'map'}
          centerReq={centerReq} // NEW
        />
      )}

      {activeTab === 'list' && (
        <ListPane
          sightings={sightings}
          loading={loading}
          errorMsg={errorMsg}
          onRefresh={() => loadSightings()}
          onEdit={(s) => beginEdit(s)}
          onDelete={handleDelete}
          onViewOnMap={(s) => { setSelectedId(s.id); setActiveTab('map'); }}
        />
      )}

      {activeTab === 'report' && (
        <ReportPane
          isEditing={!!editingId}
          onCancelEdit={clearReportForm}
          summary={summary} setSummary={setSummary}
          city={city} setCity={setCity}
          stateCode={stateCode} setStateCode={setStateCode}
          addressText={addressText} setAddressText={setAddressText}
          whenIso={whenIso} setWhenIso={setWhenIso}
          lat={lat} setLat={setLat}
          lng={lng} setLng={setLng}
          mediaFiles={mediaFiles} setMediaFiles={setMediaFiles}
          fileInputRef={fileInputRef}
   onFindAddress={async () => {
  const q = [addressText, city, stateCode].filter(Boolean).join(', ');
  if (!q) return;

  // Show Map first so Leaflet is mounted when the result arrives
  setActiveTab('map');

  try {
    setIsGeocoding(true);

    // Optional bias near last map view for this room
    const saved = roomId ? storage.get<{ lat:number; lon:number; zoom:number } | null>(`ufo:mapstate:${roomId}`, null) : null;
    const near = saved ? { lat: saved.lat, lng: saved.lon } : null;

    // 1) Strict search (requires city/state match)
    const res = await fetch('/api/geocode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        q,
        near,
        expectCity: city,
        expectState: stateCode,
      }),
    });

    if (!res.ok) {
      // 2) If strict fails, fetch candidates for a picker
      const cr = await fetch('/api/geocode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, near, candidates: true }),
      });
      if (cr.ok) {
        const { candidates } = await cr.json();
        setAltChoices(
          (candidates || []).slice(0, 8).map((c: any) => ({
            label: c.label,
            lat: Number(c.lat),
            lng: Number(c.lng),
            provider: c.provider,
          }))
        );
      } else {
        alert('No precise match found in the specified city/state.');
      }
      return;
    }

    const g = await res.json();

    // Coerce to numbers
    const latNum = g?.lat != null ? Number(g.lat) : null;
    const lngNum = g?.lng != null ? Number(g.lng) : null;

    if (latNum != null && Number.isFinite(latNum) && lngNum != null && Number.isFinite(lngNum)) {
      setAltChoices([]); // clear any prior candidates
      setLat(latNum);
      setLng(lngNum);
      setAddressText(g.address_text || q);

      // Center now and after paint (mobile-safe)
      setCenterReq((c) => c + 1);
      setTimeout(() => setCenterReq((c) => c + 1), 140);
      setTimeout(() => setCenterReq((c) => c + 1), 380);
    } else {
      alert('No precise match found.');
    }
  } catch (e: any) {
    alert(`Geocode failed: ${e?.message || e}`);
  } finally {
    setIsGeocoding(false);
  }
}
}
          onSave={upsertSighting}
          onClear={clearReportForm}
          reportAnon={reportAnon} setReportAnon={setReportAnon}
          isGeocoding={isGeocoding} isSaving={isSaving}
            altChoices={altChoices}
  setAltChoices={setAltChoices}
  setActiveTab={setActiveTab}
  setCenterReq={setCenterReq}
        />
      )}

      {activeTab === 'settings' && (
        <SettingsPane
          roomId={roomId}
          requireAuth={requireAuth}
          setRequireAuth={setRequireAuth}
          isDefaultRoom={isDefaultRoom}
          toggleDefaultRoom={toggleDefaultRoom}
          sessionEmail={sessionEmail}
          joinRoomById={joinRoomById}
          createRoom={createRoom}
          leaveRoom={leaveRoom}
          onTestNotify={async () => {
            if (!roomId) return alert('Join or create a room first.');
            const when_iso = new Date().toISOString();
            const { status, json } = await notifyRoom({
              room_id: roomId, title: 'Test notification', notes: 'Hello from the test button',
              address_text: null, lat: null, lng: null, when_iso,
            });
            alert(`/api/notify responded with ${status}\n${JSON.stringify(json, null, 2)}`);
          }}
          onEnsureMeThenTest={async () => {
            if (!roomId) return alert('Join or create a room first.');
            await ensureMember(roomId, sessionEmail || undefined);
            const when_iso = new Date().toISOString();
            const { status, json } = await notifyRoom({
              room_id: roomId, title: 'Test notification (after ensure)', notes: 'Ensured membership',
              address_text: null, lat: null, lng: null, when_iso,
            });
            alert(`/api/notify responded with ${status}\n${JSON.stringify(json, null, 2)}`);
          }}
          onPreviewRecipients={async () => {
            if (!roomId) return alert('Join or create a room first.');
            const { data, error } = await supabase
              .from('members')
              .select('email, phone_e164, approved, email_enabled, sms_enabled')
              .eq('room_id', roomId)
              .eq('approved', true);
            alert(error ? `Members query error: ${error.message}` : `Approved members:\n${JSON.stringify(data, null, 2)}`);
          }}
        />
      )}
    </main>
  );
}
