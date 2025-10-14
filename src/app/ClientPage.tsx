// src/app/ClientPage.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useSupabase } from '@/lib/useSupabase';
import { useRoom } from '@/lib/useRoom';
import { useLocalSightings } from '@/lib/useLocal';

/* ---------------- SSR-safe localStorage helper ---------------- */
const storage = {
  get<T>(key: string, fallback: T): T {
    if (typeof window === 'undefined') return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set<T>(key: string, val: T) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  },
  del(key: string) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(key);
    } catch {}
  },
};

/* ---------------- Types ---------------- */
type Sighting = {
  id: string;
  room_id: string;
  reported_at: string; // ISO
  city: string;
  state: string;
  lat: number | null;
  lon: number | null;
  shape: string | null;
  duration: string | null;
  summary: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
};

type RoomRow = {
  id: string;
  name: string;
  owner_email: string | null;
  admin_code: string;
  created_at: string;
};

/* ---------------- Small utils ---------------- */
function fmtDate(d?: string) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleString();
}
function randomCode(n = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function downloadCSV(filename: string, rows: Record<string, any>[]) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const esc = (v: any) => {
    if (v == null) return '';
    const s = String(v).replaceAll('"', '""');
    return `"${s}"`;
  };
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- Leaflet (CDN) loader (no npm deps) ---------------- */
declare global {
  interface Window {
    L?: any;
    __leafletLoading?: boolean;
    __leafletReady?: boolean;
  }
}
async function loadLeaflet(): Promise<typeof window.L> {
  if (typeof window === 'undefined') return Promise.reject('SSR');
  if (window.L && window.__leafletReady) return window.L;
  if (window.__leafletLoading) {
    return new Promise((resolve) => {
      const int = setInterval(() => {
        if (window.L && window.__leafletReady) {
          clearInterval(int);
          resolve(window.L);
        }
      }, 50);
    });
  }
  window.__leafletLoading = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  document.head.appendChild(link);
  await new Promise<void>((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.async = true;
    s.onload = () => resolve();
    document.body.appendChild(s);
  });
  window.__leafletLoading = false;
  window.__leafletReady = true;
  return window.L!;
}

/* ---------------- Page ---------------- */
export default function ClientPage() {
  const { client: supabase, user } = useSupabase();
  const {
    roomId, setRoomId,
    roomName, setRoomName,
    ownerEmail, setOwnerEmail,
    adminCode, setAdminCode,
  } = useRoom();

  const localStore = useLocalSightings(roomId);

  // preferences
  const [requireAuth, setRequireAuth] = useState<boolean>(() =>
    storage.get<boolean>('ufo:room:reqauth', false)
  );
  useEffect(() => storage.set('ufo:room:reqauth', requireAuth), [requireAuth]);

  // auth display
  const [sessionEmail, setSessionEmail] = useState<string>('');
  const [authLoading, setAuthLoading] = useState(false);
  useEffect(() => {
    let sub: any = null;
    supabase.auth.getUser().then(({ data }) => setSessionEmail(data.user?.email ?? ''));
    sub = supabase.auth.onAuthStateChange((_e, s) => setSessionEmail(s?.user?.email ?? ''));
    return () => {
      try { sub?.data.subscription.unsubscribe(); } catch {}
    };
  }, [supabase]);

  const isSignedIn = !!user;
  const canPost = !requireAuth || isSignedIn;
  const isAdmin = !!adminCode && adminCode.length >= 4;

  // filters/sort
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [sort, setSort] = useState<'new' | 'old'>('new');

  // join helpers
  const [idInput, setIdInput] = useState('');
  const [nameInput, setNameInput] = useState('');

  // form/editing
  const [editing, setEditing] = useState<Sighting | null>(null);
  const [form, setForm] = useState<Partial<Sighting>>({
    city: '',
    state: '',
    shape: '',
    duration: '',
    summary: '',
    vehicle_make: '',
    vehicle_model: '',
    lat: null,
    lon: null,
    reported_at: new Date().toISOString(),
  });

  // data
  const [sightings, setSightings] = useState<Sighting[]>([]);
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();

  // map selection
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // invite links (?roomId=)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    const rid = u.searchParams.get('roomId');
    if (rid && !roomId) {
      setRoomId(rid);
      storage.set('ufo:room:id', rid);
    }
  }, [roomId, setRoomId]);

  // load room meta
  useEffect(() => {
    if (!roomId) return;
    (async () => {
      const { data, error } = await supabase.from('rooms').select('*').eq('id', roomId).maybeSingle();
      if (!error && data) {
        const r = data as RoomRow;
        setRoomName(r.name ?? '');
        setOwnerEmail(r.owner_email ?? '');
        storage.set('ufo:room:name', r.name ?? '');
        storage.set('ufo:room:owner', r.owner_email ?? '');
      }
    })();
  }, [roomId, supabase, setRoomName, setOwnerEmail]);

  // data loader (with filters)
  const loadSightings = async (rid: string) => {
    if (!rid) {
      setSightings([]);
      return;
    }
    setLoading(true);
    let query = supabase.from('sightings').select('*').eq('room_id', rid);

    if (q.trim()) query = query.ilike('summary', `%${q}%`);
    if (stateFilter) query = query.eq('state', stateFilter);
    if (fromDate) query = query.gte('reported_at', new Date(fromDate).toISOString());
    if (toDate) {
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      query = query.lte('reported_at', end.toISOString());
    }

    query = query.order('reported_at', { ascending: sort === 'old' });

    const { data, error } = await query;
    if (!error && data) {
      const rows = data as Sighting[];
      setSightings(rows);
      try { localStore.set?.(rows); } catch {}
    }
    setLoading(false);
  };

  useEffect(() => {
    startTransition(() => { void loadSightings(roomId); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, q, stateFilter, fromDate, toDate, sort]);

  /* ---------------- Broadcast + Polling "realtime" (no DB replication) ---------------- */
  useEffect(() => {
    if (!roomId) return;

    const channel = supabase.channel(`room-${roomId}`, {
      config: { broadcast: { self: false } },
    });

    channel.on('broadcast', { event: 'sightings:changed' }, () => {
      void loadSightings(roomId);
    });

    channel.subscribe();

    const int = window.setInterval(() => {
      void loadSightings(roomId);
    }, 8000);

    return () => {
      try { supabase.removeChannel(channel); } catch {}
      window.clearInterval(int);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // auth helpers
  async function sendMagicLink(email: string) {
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    setAuthLoading(false);
    if (error) alert(error.message);
    else alert('Magic link sent! Check your email.');
  }
  async function signOut() {
    await supabase.auth.signOut();
  }

  // room helpers
  async function createRoom(name: string, email?: string) {
    const code = randomCode(6);
    const { data, error } = await supabase
      .from('rooms')
      .insert({ name, owner_email: email ?? null, admin_code: code })
      .select('*')
      .single();

    if (error) return alert(error.message);
    const r = data as RoomRow;

    setRoomId(r.id);
    setRoomName(r.name ?? '');
    setOwnerEmail(r.owner_email ?? '');
    setAdminCode(code);
    storage.set('ufo:room:id', r.id);
    storage.set('ufo:room:name', r.name ?? '');
    storage.set('ufo:room:owner', r.owner_email ?? '');
    storage.set('ufo:room:admin', code);
  }

  async function joinRoomById(id: string) {
    const { data, error } = await supabase.from('rooms').select('*').eq('id', id).maybeSingle();
    if (error || !data) return alert('Room not found.');
    const r = data as RoomRow;
    setRoomId(r.id);
    setRoomName(r.name ?? '');
    setOwnerEmail(r.owner_email ?? '');
    storage.set('ufo:room:id', r.id);
    storage.set('ufo:room:name', r.name ?? '');
    storage.set('ufo:room:owner', r.owner_email ?? '');
  }

  async function findRoomIdByName(name: string) {
    const { data, error } = await supabase
      .from('rooms')
      .select('id')
      .ilike('name', name)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { id: string }).id;
  }

  function leaveRoom() {
    setRoomId('');
    setRoomName('');
    setOwnerEmail('');
    setAdminCode('');
    storage.del('ufo:room:id');
    storage.del('ufo:room:name');
    storage.del('ufo:room:owner');
    storage.del('ufo:room:admin');
    setSightings([]);
    setSelectedId(null);
  }

  // sightings CRUD
  async function upsertSighting() {
    if (!roomId) return alert('Pick or create a room first.');
    if (!canPost) return alert('Sign in required to post.');

    const payload = {
      room_id: roomId,
      city: (form.city ?? '').trim(),
      state: (form.state ?? '').trim().toUpperCase(),
      shape: (form.shape ?? '').trim() || null,
      duration: (form.duration ?? '').trim() || null,
      summary: (form.summary ?? '').trim(),
      vehicle_make: (form.vehicle_make ?? '').trim() || null,
      vehicle_model: (form.vehicle_model ?? '').trim() || null,
      lat: form.lat ?? null,
      lon: form.lon ?? null,
      reported_at: form.reported_at ?? new Date().toISOString(),
      created_by: sessionEmail || null,
    };

    if (!payload.city || !payload.state || !payload.summary) {
      return alert('City, State, and Summary are required.');
    }

    if (editing) {
      const { error } = await supabase.from('sightings').update(payload).eq('id', editing.id);
      if (error) return alert(error.message);
      setEditing(null);
    } else {
      const { error } = await supabase.from('sightings').insert(payload);
      if (error) return alert(error.message);
    }

    // broadcast change so other clients refresh
    try {
      await supabase.channel(`room-${roomId}`).send({
        type: 'broadcast',
        event: 'sightings:changed',
        payload: { roomId },
      });
    } catch {}

    setForm({
      city: '',
      state: '',
      shape: '',
      duration: '',
      summary: '',
      vehicle_make: '',
      vehicle_model: '',
      lat: null,
      lon: null,
      reported_at: new Date().toISOString(),
    });
  }

  async function deleteSighting(id: string) {
    if (!isAdmin) return alert('Admin code required to delete.');
    if (!confirm('Delete this sighting?')) return;
    const { error } = await supabase.from('sightings').delete().eq('id', id);
    if (error) alert(error.message);

    // broadcast change so other clients refresh
    try {
      await supabase.channel(`room-${roomId}`).send({
        type: 'broadcast',
        event: 'sightings:changed',
        payload: { roomId },
      });
    } catch {}
  }

  // derived
  const filtered = useMemo(() => sightings, [sightings]);

  /* ---------------- Map component (CDN Leaflet) ---------------- */
  function MapPane({ points, selectedId, onSelect }: {
    points: Sighting[];
    selectedId: string | null;
    onSelect: (id: string) => void;
  }) {
    const mapRef = useRef<any>(null);
    const markersRef = useRef<any[]>([]);

    // init map once
    useEffect(() => {
      let mounted = true;
      (async () => {
        const L = await loadLeaflet();
        if (!mounted) return;

        if (!mapRef.current) {
          const mapDiv = document.getElementById('ufo-map');
          if (!mapDiv) return;
          const m = L.map(mapDiv).setView([39.5, -98.35], 4);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
          }).addTo(m);
          (mapRef as any).current = m;
        }
      })();
      return () => { mounted = false; };
    }, []);

    // update markers when points change
    useEffect(() => {
      (async () => {
        const L = await loadLeaflet();
        const m = mapRef.current;
        if (!m) return;

        markersRef.current.forEach((mk) => m.removeLayer(mk));
        markersRef.current = [];

        const bounds = L.latLngBounds([]);
        points.forEach((p) => {
          if (p.lat != null && p.lon != null) {
            const mk = L.marker([p.lat, p.lon]);
            mk.on('click', () => onSelect(p.id));
            mk.addTo(m);
            markersRef.current.push(mk);
            bounds.extend([p.lat, p.lon]);
          }
        });

        if (markersRef.current.length) {
          m.fitBounds(bounds.pad(0.2));
        }
      })();
    }, [points, onSelect]);

    // pan to selected
    useEffect(() => {
      (async () => {
        const m = mapRef.current;
        if (!m || !selectedId) return;
        const s = points.find((x) => x.id === selectedId);
        if (s && s.lat != null && s.lon != null) {
          m.setView([s.lat, s.lon], Math.max(m.getZoom(), 7), { animate: true });
        }
      })();
    }, [selectedId, points]);

    return <div id="ufo-map" className="h-[520px] md:h-[650px] w-full rounded-xl border" />;
  }

  // copy feedback
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);

  // scroll to selected in list
  useEffect(() => {
    if (!selectedId) return;
    const el = document.getElementById(`sighting-${selectedId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selectedId]);

  /* ---------------- UI ---------------- */
  return (
    <main className="mx-auto max-w-7xl p-4 space-y-6">
      {/* Header */}
      <header className="flex items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">UFO Sightings Tracker</h1>
          <p className="text-sm text-gray-500 mt-1">
            Room: {roomName ? <span className="font-medium">{roomName}</span> : <em>none</em>}
            {roomId ? <span className="ml-2 text-xs text-gray-400">({roomId})</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSignedIn ? (
            <>
              <span className="text-sm">Signed in as <span className="font-medium">{sessionEmail}</span></span>
              <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <AuthBox onSend={sendMagicLink} loading={authLoading} />
          )}
        </div>
      </header>

      {/* Top controls: Create / Join */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-2xl border p-4 space-y-3">
          <h2 className="font-semibold">Create a Room</h2>
          <RoomCreate onCreate={createRoom} />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={requireAuth}
                onChange={(e) => setRequireAuth(e.target.checked)}
              />
              Require sign-in to post
            </label>
            <button className="text-sm text-red-600 hover:underline" onClick={leaveRoom}>
              Leave room
            </button>
          </div>
        </div>

        <div className="rounded-2xl border p-4 space-y-3">
          <h2 className="font-semibold">Join / Share</h2>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
            <input
              className="md:col-span-6 rounded-md border px-3 py-2"
              placeholder="Room ID (UUID)"
              value={idInput}
              onChange={(e) => setIdInput(e.target.value)}
            />
            <button
              className="md:col-span-2 rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
              onClick={() => idInput.trim() && joinRoomById(idInput.trim())}
              disabled={!idInput.trim()}
            >
              Join by ID
            </button>
            <input
              className="md:col-span-3 rounded-md border px-3 py-2"
              placeholder="Or join by name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
            />
            <button
              className="md:col-span-1 rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
              onClick={async () => {
                const rid = await findRoomIdByName(nameInput.trim());
                if (!rid) return alert('No room found with that name.');
                await joinRoomById(rid);
              }}
              disabled={!nameInput.trim()}
            >
              Go
            </button>
          </div>

          <AdminBox
            adminCode={adminCode}
            setAdminCode={(v) => { setAdminCode(v); storage.set('ufo:room:admin', v); }}
          />
          <ShareLink
            roomId={roomId}
            onCopied={() => {
              setCopied(true);
              if (copyTimer.current) window.clearTimeout(copyTimer.current);
              copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
            }}
          />
          {copied && <p className="text-xs text-green-600">Copied!</p>}
        </div>
      </section>

      {/* Filters */}
      <section className="rounded-2xl border p-4 grid grid-cols-1 md:grid-cols-12 gap-3">
        <input
          className="md:col-span-4 rounded-md border px-3 py-2"
          placeholder="Search summary…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          className="md:col-span-2 rounded-md border px-3 py-2"
          placeholder="State (e.g., NY)"
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value.toUpperCase())}
          maxLength={2}
        />
        <input
          type="date"
          className="md:col-span-2 rounded-md border px-3 py-2"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
        />
        <input
          type="date"
          className="md:col-span-2 rounded-md border px-3 py-2"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
        />
        <select
          className="md:col-span-2 rounded-md border px-3 py-2"
          value={sort}
          onChange={(e) => setSort(e.target.value as any)}
        >
          <option value="new">Newest first</option>
          <option value="old">Oldest first</option>
        </select>
        <div className="md:col-span-12">
          <button
            className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
            onClick={() => downloadCSV(`sightings-${roomName || roomId || 'room'}.csv`, filtered)}
            disabled={!filtered.length}
          >
            Export CSV
          </button>
        </div>
      </section>

      {/* Map + List layout */}
      <section className="grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-7">
          <MapPane
            points={filtered}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
          />
        </div>
        <div className="md:col-span-5 rounded-2xl border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <h2 className="font-semibold">Sightings ({filtered.length})</h2>
            {(loading || isPending) && <span className="text-xs text-gray-500">Loading…</span>}
          </div>
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-500">No sightings yet.</p>
          ) : (
            <ul className="divide-y max-h-[650px] overflow-auto">
              {filtered.map((s) => (
                <li
                  key={s.id}
                  id={`sighting-${s.id}`}
                  className={`p-4 cursor-pointer ${selectedId === s.id ? 'bg-gray-50' : ''}`}
                  onClick={() => setSelectedId(s.id)}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm text-gray-500">
                        {s.city}, {s.state} • {fmtDate(s.reported_at)}
                      </div>
                      <p className="mt-1">{s.summary}</p>
                      <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-600">
                        {s.shape ? <span>Shape: <b>{s.shape}</b></span> : null}
                        {s.duration ? <span>Duration: <b>{s.duration}</b></span> : null}
                        {(s.vehicle_make || s.vehicle_model) ? (
                          <span>Vehicle: <b>{[s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ')}</b></span>
                        ) : null}
                        {s.lat != null && s.lon != null ? <span>Coords: {s.lat}, {s.lon}</span> : null}
                        {s.created_by ? <span>By: {s.created_by}</span> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        className="text-sm text-gray-700 hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(s);
                          setForm({
                            city: s.city,
                            state: s.state,
                            shape: s.shape ?? '',
                            duration: s.duration ?? '',
                            summary: s.summary,
                            vehicle_make: s.vehicle_make ?? '',
                            vehicle_model: s.vehicle_model ?? '',
                            lat: s.lat,
                            lon: s.lon,
                            reported_at: s.reported_at,
                          });
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="text-sm text-red-600 hover:underline"
                        onClick={(e) => { e.stopPropagation(); deleteSighting(s.id); }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Compose */}
      <section className="rounded-2xl border p-4 space-y-3">
        <h2 className="font-semibold">{editing ? 'Edit Sighting' : 'Add Sighting'}</h2>
        {!canPost && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
            Posting is limited to signed-in users. Please sign in first.
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <input
            className="md:col-span-3 rounded-md border px-3 py-2"
            placeholder="City"
            value={form.city ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
          />
          <input
            className="md:col-span-2 rounded-md border px-3 py-2"
            placeholder="State"
            value={form.state ?? ''}
            maxLength={2}
            onChange={(e) => setForm((f) => ({ ...f, state: e.target.value.toUpperCase() }))}
          />
          <input
            className="md:col-span-2 rounded-md border px-3 py-2"
            placeholder="Vehicle Make (optional)"
            value={form.vehicle_make ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, vehicle_make: e.target.value }))}
          />
          <input
            className="md:col-span-2 rounded-md border px-3 py-2"
            placeholder="Vehicle Model (optional)"
            value={form.vehicle_model ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, vehicle_model: e.target.value }))}
          />
          <input
            className="md:col-span-3 rounded-md border px-3 py-2"
            placeholder="Shape (optional)"
            value={form.shape ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, shape: e.target.value }))}
          />
          <input
            className="md:col-span-2 rounded-md border px-3 py-2"
            placeholder="Duration (optional)"
            value={form.duration ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))}
          />
          <input
            type="datetime-local"
            className="md:col-span-3 rounded-md border px-3 py-2"
            value={
              form.reported_at
                ? new Date(form.reported_at).toISOString().slice(0, 16)
                : new Date().toISOString().slice(0, 16)
            }
            onChange={(e) => {
              const iso = new Date(e.target.value).toISOString();
              setForm((f) => ({ ...f, reported_at: iso }));
            }}
          />
          <input
            className="md:col-span-2 rounded-md border px-3 py-2"
            placeholder="Latitude (optional)"
            value={form.lat ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value ? Number(e.target.value) : null }))}
          />
          <input
            className="md:col-span-2 rounded-md border px-3 py-2"
            placeholder="Longitude (optional)"
            value={form.lon ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, lon: e.target.value ? Number(e.target.value) : null }))}
          />
          <textarea
            className="md:col-span-12 rounded-md border px-3 py-2"
            placeholder="Summary (what happened?)"
            value={form.summary ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
            rows={3}
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
            onClick={upsertSighting}
            disabled={!canPost}
          >
            {editing ? 'Save Changes' : 'Add Sighting'}
          </button>
          {editing && (
            <button
              className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
              onClick={() => {
                setEditing(null);
                setForm({
                  city: '',
                  state: '',
                  shape: '',
                  duration: '',
                  summary: '',
                  vehicle_make: '',
                  vehicle_model: '',
                  lat: null,
                  lon: null,
                  reported_at: new Date().toISOString(),
                });
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </section>

      {/* Schema helper */}
      <details className="rounded-2xl border p-4 text-sm text-gray-600">
        <summary className="cursor-pointer font-medium">Supabase schema notes</summary>
        <pre className="mt-3 whitespace-pre-wrap">
{`-- Add vehicle fields if you haven't already (run once):
alter table public.sightings add column if not exists vehicle_make text;
alter table public.sightings add column if not exists vehicle_model text;`}
        </pre>
      </details>
    </main>
  );
}

/* ---------------- Subcomponents ---------------- */
function AuthBox({ onSend, loading }: { onSend: (email: string) => void; loading: boolean }) {
  const [email, setEmail] = useState('');
  return (
    <div className="flex items-center gap-2">
      <input
        className="rounded-md border px-3 py-1.5 text-sm"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSend(email); }}
      />
      <button
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
        onClick={() => onSend(email)}
        disabled={loading || !email.includes('@')}
      >
        {loading ? 'Sending…' : 'Email link'}
      </button>
    </div>
  );
}

function RoomCreate({ onCreate }: { onCreate: (name: string, email?: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
      <input
        className="md:col-span-5 rounded-md border px-3 py-2"
        placeholder="Room name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="md:col-span-5 rounded-md border px-3 py-2"
        placeholder="Owner email (optional)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button
        className="md:col-span-2 rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
        onClick={() => onCreate(name.trim(), email.trim() || undefined)}
        disabled={!name.trim()}
      >
        Create
      </button>
    </div>
  );
}

function AdminBox({
  adminCode,
  setAdminCode,
}: {
  adminCode: string;
  setAdminCode: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="text-sm">Admin code:</label>
      <input
        className="flex-1 rounded-md border px-3 py-2"
        placeholder="Enter admin code to enable delete"
        value={adminCode}
        onChange={(e) => setAdminCode(e.target.value.trim().toUpperCase())}
      />
    </div>
  );
}

function ShareLink({ roomId, onCopied }: { roomId: string; onCopied: () => void }) {
  if (!roomId) return <p className="text-sm text-gray-500">Create or join a room to get a share link.</p>;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const link = origin ? `${origin}/?roomId=${roomId}` : `/?roomId=${roomId}`;
  return (
    <div className="flex items-center gap-2">
      <input className="flex-1 rounded-md border px-3 py-2" value={link} readOnly />
      <button
        className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
        onClick={() => {
          navigator.clipboard.writeText(link).then(onCopied).catch(() => {});
        }}
      >
        Copy
      </button>
    </div>
  );
}
