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
    try {
      const raw = window.localStorage.getItem(k);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  remove(k: string) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(k);
    } catch {}
  },
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
// Deep-link/default room
// ======================
const STORAGE_LAST = 'ufo:lastRoomId';
const STORAGE_DEFAULT = 'ufo:defaultRoomId';

// =========
// Utilities
// =========
function getBaseUrl() {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}
function fmtLocal(dtIso?: string | null) {
  if (!dtIso) return '';
  try {
    const d = new Date(dtIso);
    return d.toLocaleString();
  } catch {
    return dtIso!;
  }
}
function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}
function buildStorageKey(roomId: string, filename: string) {
  const safeName = filename.replace(/\s+/g, '_');
  return `${roomId}/${randomId()}-${safeName}`;
}
// Convert a Date/ISO to yyyy-MM-ddTHH:mm (LOCAL timezone) for <input type="datetime-local">
function toLocalInputValue(dOrIso: Date | string) {
  const d = typeof dOrIso === 'string' ? new Date(dOrIso) : dOrIso;
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}
async function geocodeAddress(q: string) {
  const r = await fetch('/api/geocode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q }),
  });
  if (!r.ok) throw new Error(`geocode failed: ${r.status}`);
  return (await r.json()) as { address_text?: string; lat?: number; lng?: number };
}
async function ensureMember(roomId: string, email?: string, phone_e164?: string) {
  if (!roomId || (!email && !phone_e164)) return;
  try {
    const res = await fetch('/api/members/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room_id: roomId, email, phone_e164 }),
    });
    await res.json().catch(() => ({}));
  } catch {}
}
async function notifyRoom(params: {
  room_id: string;
  title: string;
  notes?: string;
  address_text?: string | null;
  lat?: number | null;
  lng?: number | null;
  when_iso?: string | null;
}) {
  try {
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: String(e) } };
  }
}

// ==========================
// Leaflet loader (client-only)
// ==========================
function injectLeafletCssOnce() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('leaflet-css')) return;
  const link = document.createElement('link');
  link.id = 'leaflet-css';
  link.rel = 'stylesheet';
  link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
  link.crossOrigin = '';
  document.head.appendChild(link);
}
async function loadLeaflet(): Promise<any> {
  if (typeof window === 'undefined') return null;
  injectLeafletCssOnce();
  const L = await import('leaflet');
  return L;
}
function mapStateKey(roomId: string) {
  return `ufo:mapstate:${roomId || 'none'}`;
}

// =================================================================
// ---------- Hoisted child components so they don’t remount ----------
// =================================================================
function MapPane({
  roomId,
  points,
  selectedId,
  draft, // { lat, lon }
  onSelect,
  onMapClick,
}: {
  roomId: string;
  points: Sighting[];
  selectedId: string | null;
  draft?: { lat: number | null; lon: number | null };
  onSelect: (id: string) => void;
  onMapClick: (lat: number, lon: number) => void;
}) {
  const mapRef = useRef<any>(null);
  const sightingsLayerRef = useRef<any | null>(null);
  const draftLayerRef = useRef<any | null>(null);
  const shouldAutofitRef = useRef(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const L = await loadLeaflet();
      if (!mounted || !L) return;

      if (!mapRef.current) {
        const node = document.getElementById('ufo-map');
        if (!node) return;
        const m = L.map(node).setView([39.5, -98.35], 4);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(m);

        sightingsLayerRef.current = L.layerGroup().addTo(m);
        draftLayerRef.current = L.layerGroup().addTo(m);

        const saved = storage.get<{ lat: number; lon: number; zoom: number } | null>(mapStateKey(roomId));
        if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && Number.isFinite(saved.zoom)) {
          m.setView([saved.lat, saved.lon], saved.zoom, { animate: false });
          shouldAutofitRef.current = false;
        }

        m.on('moveend zoomend', () => {
          const c = m.getCenter();
          const z = m.getZoom();
          storage.set(mapStateKey(roomId), { lat: c.lat, lon: c.lng, zoom: z });
        });

        const stopAutofit = () => { shouldAutofitRef.current = false; };
        m.on('zoomstart', stopAutofit);
        m.on('dragstart', stopAutofit);

        m.on('click', (ev: any) => {
          const { lat, lng } = ev.latlng;
          onMapClick(lat, lng);
        });

        mapRef.current = m;
      } else {
        const m = mapRef.current;
        const saved = storage.get<{ lat: number; lon: number; zoom: number } | null>(mapStateKey(roomId));
        if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && Number.isFinite(saved.zoom)) {
          m.setView([saved.lat, saved.lon], saved.zoom, { animate: false });
          shouldAutofitRef.current = false;
        } else {
          shouldAutofitRef.current = true;
          m.setView([39.5, -98.35], 4, { animate: false });
        }
      }
    })();
    return () => { mounted = false; };
  }, [roomId, onMapClick]);

  // Render sightings
  useEffect(() => {
    (async () => {
      const L = await loadLeaflet();
      if (!L) return;
      const m = mapRef.current;
      const layer = sightingsLayerRef.current;
      if (!m || !layer) return;

      layer.clearLayers();
      const bounds = L.latLngBounds([]);

      points.forEach((p) => {
        if (p.lat == null || p.lng == null) return;
        const isSel = selectedId === p.id;
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
             </div>`
          );

        marker.addTo(layer);
        bounds.extend([p.lat, p.lng]);
      });

      if (shouldAutofitRef.current && bounds.isValid()) {
        m.fitBounds(bounds.pad(0.15), { animate: false });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, selectedId]);

  // Render draft pin
  useEffect(() => {
    (async () => {
      const L = await loadLeaflet();
      if (!L) return;
      const layer = draftLayerRef.current;
      if (!layer) return;
      layer.clearLayers();
      if (draft?.lat != null && draft?.lon != null) {
        const marker = L.circleMarker([draft.lat, draft.lon], {
          radius: 7,
          weight: 2,
          color: '#16a34a',
          fillColor: '#bbf7d0',
          fillOpacity: 0.9,
        }).bindTooltip('New pin', { permanent: false });
        marker.addTo(layer);
      }
    })();
  }, [draft?.lat, draft?.lon]);

  return (
    <div className="rounded-2xl border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">Map</h3>
        <div className="text-xs text-gray-500">Tap the map to drop a pin into the Report form.</div>
      </div>
      <div id="ufo-map" className="w-full h-96 rounded-md overflow-hidden" />
    </div>
  );
}

function ListPane({
  sightings, loading, errorMsg, onRefresh, onEdit, onDelete,
}: {
  sightings: Sighting[]; loading: boolean; errorMsg: string | null; onRefresh: () => void;
  onEdit: (s: Sighting) => void; onDelete: (s: Sighting) => Promise<void>;
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
              <button
                className="rounded-md border px-2 py-1 text-xs text-red-700"
                onClick={() => onDelete(s)}
              >Delete</button>
              {s.lat != null && s.lng != null && (
                <div className="ml-auto text-xs text-gray-500">
                  {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
                </div>
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
        <input
          readOnly
          value={link}
          className="flex-1 rounded-md border px-3 py-2 text-sm"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
          onClick={async () => {
            try { await navigator.clipboard.writeText(link); alert('Link copied'); }
            catch { window.prompt('Copy this link:', link); }
          }}
        >
          Copy
        </button>
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
          placeholder="Join by Room ID (UUID) or Short Code"
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
            const v = prompt('Enter Room ID or Short Code');
            if (v) void joinRoomById(v.trim());
          }}
        >
          Join
        </button>
        <div className="md:col-span-4 flex items-center justify-end">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={requireAuth}
              onChange={(e) => setRequireAuth(e.target.checked)}
            />
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
          >
            Create
          </button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={leaveRoom}>
            Leave room
          </button>
        </div>
        {roomId && <ShareLink roomId={roomId} />}

        {/* Default room toggle */}
        {roomId && (
          <div className="mt-3 rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={isDefaultRoom} onChange={toggleDefaultRoom} />
              Make this my default room on this device
            </label>
            <p className="text-xs text-gray-500 mt-1">
              You’ll auto-join this room when you open the app. You can change this anytime.
            </p>
          </div>
        )}
      </div>

      {/* Notifications */}
      <div className="mt-4 rounded-md border p-3">
        <h3 className="font-medium mb-2">Notifications</h3>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={onTestNotify}>
            Send Test Email/SMS
          </button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={onEnsureMeThenTest}>
            Ensure I’m a member, then Test
          </button>
          <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={onPreviewRecipients}>
            Preview recipients
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Post at least one sighting while signed in so the app can auto-add you to <code>members</code>.
        </p>
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
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, phone_e164: phone }),
              });
              const json = await r.json().catch(() => ({}));
              alert(`Saved: ${r.status}\n${JSON.stringify(json, null, 2)}`);
            }}
          >
            Save my number for SMS
          </button>
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
}) {
  const [vehicleMake, setVehicleMake] = useState('');
  const [vehicleModel, setVehicleModel] = useState('');
  const [vehicleColor, setVehicleColor] = useState('');
  (globalThis as any).__ufoVehicle = { vehicleMake, vehicleModel, vehicleColor };

  return (
    <div className="rounded-2xl border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{isEditing ? 'Edit sighting' : 'Report a sighting'}</h3>
        {isEditing && (
          <button className="rounded-md border px-3 py-1 text-sm" onClick={onCancelEdit}>Cancel edit</button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm">Summary *</span>
          <input
            className="rounded-md border px-3 py-2"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm">When</span>
          <input
            className="rounded-md border px-3 py-2"
            type="datetime-local"
            value={whenIso ? toLocalInputValue(whenIso) : toLocalInputValue(new Date())}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) { setWhenIso(''); return; }
              const local = new Date(v);
              setWhenIso(local.toISOString());
            }}
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
              placeholder='e.g. "Post Office, Glen Cove, NY"'
              value={addressText}
              onChange={(e) => setAddressText(e.target.value)}
            />
            <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={onFindAddress}>
              Find Address
            </button>
          </div>
          {!!(lat && lng) && (
            <p className="text-xs text-gray-500 mt-1">
              Pinned: {lat.toFixed(5)}, {lng.toFixed(5)}
            </p>
          )}
        </label>

        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-sm">Photos / Video (adding files will append)</span>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                hidden
                onChange={(e) => {
                  const files = e.currentTarget.files ? Array.from(e.currentTarget.files) : [];
                  setMediaFiles(files);
                }}
              />
              Choose files…
            </label>
            {mediaFiles.length > 0 && (
              <span className="text-xs text-gray-600">{mediaFiles.length} selected</span>
            )}
          </div>
        </label>
      </div>

      <div className="flex gap-2">
        <button className="rounded-md border px-4 py-2" onClick={onSave}>
          {isEditing ? 'Update sighting' : 'Save sighting'}
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
  // Tabs
  const [activeTab, setActiveTab] = useState<'map' | 'list' | 'report' | 'settings'>('map');

  // Session/user
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  // Room
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [requireAuth, setRequireAuth] = useState<boolean>(false);

  // Default room toggle
  const [isDefaultRoom, setIsDefaultRoom] = useState<boolean>(false);

  // Sightings + list state
  const [sightings, setSightings] = useState<Sighting[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Report form state
  const [summary, setSummary] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [addressText, setAddressText] = useState<string>('');
  const [whenIso, setWhenIso] = useState<string>('');
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingOriginalMedia, setEditingOriginalMedia] = useState<string[] | null>(null);

  // Default the report time to "now" (local) on first load
  useEffect(() => {
    if (!whenIso) setWhenIso(new Date().toISOString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load session/email
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!mounted) return;
      setSessionEmail(data.user?.email ?? null);
    })();
    const sub = supabase.auth.onAuthStateChange((_e, sess) => {
      setSessionEmail(sess?.user?.email ?? null);
    });
    return () => {
      mounted = false;
      sub.data.subscription.unsubscribe();
    };
  }, []);

  // Deep-link & default/last room auto-selection
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    theRoom(url);
    function theRoom(u: URL) {
      const paramRoom = (u.searchParams.get('room') || '').trim();
      const defaultId = storage.get<string>(STORAGE_DEFAULT);
      const lastId = storage.get<string>(STORAGE_LAST);
      const envDefault = process.env.NEXT_PUBLIC_DEFAULT_ROOM_ID || null;
      const target = paramRoom || defaultId || lastId || envDefault;
      if (target && !roomId) void joinRoomById(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track/store last room and default toggle
  useEffect(() => {
    if (roomId) {
      storage.set(STORAGE_LAST, roomId);
      const curDefault = storage.get<string>(STORAGE_DEFAULT);
      setIsDefaultRoom(!!roomId && curDefault === roomId);
    } else {
      setIsDefaultRoom(false);
    }
  }, [roomId]);

  function toggleDefaultRoom() {
    if (!roomId) return;
    const cur = storage.get<string>(STORAGE_DEFAULT);
    if (cur === roomId) {
      storage.remove(STORAGE_DEFAULT);
      setIsDefaultRoom(false);
    } else {
      storage.set(STORAGE_DEFAULT, roomId);
      setIsDefaultRoom(true);
    }
  }

  // Room helpers
  async function joinRoomById(input: string) {
    const id = (input || '').trim();
    if (!id) return;
    const { data, error } = await supabase
      .from('rooms')
      .select('id, name')
      .or(`id.eq.${id},short_code.eq.${id}`)
      .maybeSingle();
    if (error) return alert(`Join failed: ${error.message}`);
    if (!data) return alert('Room not found.');
    setRoomId(data.id);
    setRoomName(data.name);
    await loadSightings(data.id);
  }
  async function createRoom(r: { name?: string | null; owner_email?: string | null }) {
    const payload = {
      name: r.name || null,
      owner_email: r.owner_email || sessionEmail || null,
      short_code:
        (r.name || 'room').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 10) +
        '-' + Math.random().toString(36).slice(2, 6),
    };
    const { data, error } = await supabase.from('rooms').insert(payload).select('id, name').single();
    if (error) return alert(`Create room failed: ${error.message}`);
    setRoomId(data.id);
    setRoomName(data.name);
    await loadSightings(data.id);
  }
  function leaveRoom() {
    setRoomId(null);
    setRoomName(null);
    setSightings([]);
  }

  // Sightings load / refresh
  async function loadSightings(id = roomId) {
    if (!id) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase
        .from('sightings')
        .select('id, room_id, summary, city, state, address_text, lat, lng, reported_at, user_name, media_urls, vehicle_make, vehicle_model, vehicle_color')
        .eq('room_id', id)
        .order('reported_at', { ascending: false });
      if (error) setErrorMsg(error.message);
      else setSightings((data || []) as Sighting[]);
    } catch (e: any) {
      setErrorMsg(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (roomId) void loadSightings(roomId); /* eslint-disable-next-line */ }, [roomId]);

  // Media upload
  async function uploadFilesForRoom(room: string, files: File[]): Promise<string[]> {
    if (!files.length) return [];
    const urls: string[] = [];
    for (const f of files) {
      const key = buildStorageKey(room, f.name);
      const { error } = await supabase.storage.from('sighting-photos').upload(key, f, {
        cacheControl: '3600', upsert: false,
      });
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
          const g = await geocodeAddress(q);
          if (g?.lat != null && g?.lng != null) {
            resolved = { address_text: g.address_text || q, lat: g.lat!, lng: g.lng! };
            setAddressText(resolved.address_text || '');
            setLat(resolved.lat!);
            setLng(resolved.lng!);
          }
        }
      } catch {}
    }

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
      user_name: sessionEmail || 'anonymous',
      vehicle_make, vehicle_model, vehicle_color,
    };

    if (!base.summary || !base.city || !base.state) {
      return alert('City, State, and Summary are required.');
    }

    try {
      let finalMedia: string[] | null = editingId ? (editingOriginalMedia ? [...editingOriginalMedia] : null) : null;

      // Upload new media (append if editing)
      if (mediaFiles.length) {
        const newUrls = await uploadFilesForRoom(roomId, mediaFiles);
        finalMedia = (finalMedia || []).concat(newUrls);
      }

      if (!editingId) {
        // Insert new
        const { error } = await supabase.from('sightings').insert({
          ...base,
          media_urls: finalMedia,
        }).select('id').single();
        if (error) return alert(`Upload failed: ${error.message}`);

        // Ensure you’re a member so notify has a recipient
        await ensureMember(roomId, sessionEmail || undefined);

        // Notify (best-effort)
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
      } else {
        // Update existing
        const { error } = await supabase
          .from('sightings')
          .update({ ...base, media_urls: finalMedia })
          .eq('id', editingId);
        if (error) return alert(`Update failed: ${error.message}`);
      }

      await loadSightings(roomId);
      clearReportForm();
      setActiveTab('list');
    } catch (e: any) {
      alert(`Save failed: ${e?.message || String(e)}`);
    }
  }

  function clearReportForm() {
    setSummary(''); setCity(''); setStateCode(''); setAddressText('');
    setLat(null); setLng(null); setWhenIso('');
    setMediaFiles([]); if (fileInputRef.current) fileInputRef.current.value = '';
    setEditingId(null); setEditingOriginalMedia(null);
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
    setLat(s.lat ?? null);
    setLng(s.lng ?? null);
    setWhenIso(s.reported_at || new Date().toISOString());
    setActiveTab('report');
    // vehicle fields are written by child into global each render; seed via prompt-less approach:
    (globalThis as any).__ufoVehicle = {
      vehicleMake: s.vehicle_make || '',
      vehicleModel: s.vehicle_model || '',
      vehicleColor: s.vehicle_color || '',
    };
  }

  // ===========
  // Page header
  // ===========
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
              <button
                className="rounded-md border px-3 py-1 text-sm"
                onClick={async () => {
                  const email = prompt('Enter email to magic-link sign in'); if (!email) return;
                  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
                  alert(error ? `Sign-in error: ${error.message}` : 'Check your email for the magic link!');
                }}
              >Sign in</button>
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

      {/* Panels */}
      {activeTab === 'map' && (
        <MapPane
          roomId={roomId || 'none'}
          points={sightings}
          selectedId={null}
          draft={{ lat: lat ?? null, lon: lng ?? null }}
          onSelect={() => setActiveTab('list')}
          onMapClick={async (clat, clon) => {
            setLat(clat); setLng(clon);
            try { const g = await geocodeAddress(`${clat}, ${clon}`); if (g?.address_text) setAddressText(g.address_text); } catch {}
            setActiveTab('report');
          }}
        />
      )}

      {activeTab === 'list' && (
        <ListPane
          sightings={sightings}
          loading={loading}
          errorMsg={errorMsg}
          onRefresh={() => loadSightings()}
          onEdit={beginEdit}
          onDelete={handleDelete}
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
            try {
              const g = await geocodeAddress(q);
              if (g?.lat != null && g?.lng != null) {
                setLat(g.lat); setLng(g.lng); setAddressText(g.address_text || q);
                setActiveTab('map');
              } else { alert('No match found.'); }
            } catch (e: any) { alert(`Geocode failed: ${e?.message || e}`); }
          }}
          onSave={upsertSighting}
          onClear={clearReportForm}
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
            alert(error ? `Members query error: ${error.message}` :
              `Approved members:\n${JSON.stringify(data, null, 2)}`);
          }}
        />
      )}
    </main>
  );
}
