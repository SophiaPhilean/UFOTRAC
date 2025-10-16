// src/app/ClientPage.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSupabase } from '@/lib/useSupabase';
import { useRoom } from '@/lib/useRoom';
import { useLocalSightings } from '@/lib/useLocal';

/* ---------- SSR-safe localStorage helpers ---------- */
const storage = {
  get<T>(key: string, fallback: T): T {
    if (typeof window === 'undefined') return fallback;
    try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
  },
  set<T>(key: string, val: T) { if (typeof window !== 'undefined') try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  del(key: string) { if (typeof window !== 'undefined') try { localStorage.removeItem(key); } catch {} },
};

/* ---------- Types ---------- */
type Sighting = {
  id: string;
  room_id: string;
  reported_at: string; // ISO
  when_iso?: string | null;
  city: string;
  state: string;
  lat: number | null;
  lon: number | null;
  lng?: number | null;
  shape: string | null;
  duration: string | null;
  summary: string;
  title?: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  created_by: string | null;
  user_name?: string | null;
  photo_url: string | null;
  address_text: string | null;
  created_at?: string;
  updated_at?: string | null;
};

type RoomRow = {
  id: string;
  name: string;
  owner_email: string | null;
  admin_code: string;
  short_code: string | null;
  created_at: string;
};

/* ---------- Utils ---------- */
function fmtDate(d?: string) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleString();
}
function randomCode(n = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function downloadCSV(filename: string, rows: Record<string, any>[]) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const esc = (v: any) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}
/** Remove quotes/odd chars from ids and filenames for storage paths */
function cleanId(s: string) { return (s || '').trim().replace(/["'`]/g, ''); }
function cleanFileName(name: string) { return name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, ''); }
/** ISO → <input type="datetime-local"> (local time) */
function toLocalInputValue(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const mapStateKey = (roomId: string) => `ufo:map:${roomId}`;

/* ---------- Leaflet (CDN) ---------- */
declare global { interface Window { L?: any; __leafletLoading?: boolean; __leafletReady?: boolean; } }
async function loadLeaflet(): Promise<typeof window.L> {
  if (typeof window === 'undefined') throw new Error('SSR');
  if (window.L && window.__leafletReady) return window.L;
  if (window.__leafletLoading) {
    return new Promise(res => {
      const t = setInterval(() => { if (window.L && window.__leafletReady) { clearInterval(t); res(window.L); } }, 50);
    });
  }
  window.__leafletLoading = true;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(link);
  await new Promise<void>(r => { const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; s.async = true; s.onload = () => r(); document.body.appendChild(s); });
  window.__leafletLoading = false; window.__leafletReady = true; return window.L!;
}

/* ---------- Page ---------- */
export default function ClientPage() {
  const { client: supabase, user } = useSupabase();
  const { roomId, setRoomId, roomName, setRoomName, ownerEmail, setOwnerEmail, adminCode, setAdminCode } = useRoom();
  const localStore = useLocalSightings(roomId);

  // Hydration guard
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);

  // UI state
  const [activeTab, setActiveTab] = useState<'list'|'map'|'compose'|'settings'>('list');
  const [requireAuth, setRequireAuth] = useState<boolean>(() => storage.get('ufo:reqauth', false));
  useEffect(() => storage.set('ufo:reqauth', requireAuth), [requireAuth]);

  // auth
  const [sessionEmail, setSessionEmail] = useState<string>(''); 
  const [authLoading, setAuthLoading] = useState(false);
  useEffect(() => {
    const sub = supabase.auth.onAuthStateChange((_e, s) => setSessionEmail(s?.user?.email ?? ''));
    supabase.auth.getUser().then(({ data }) => setSessionEmail(data.user?.email ?? ''));
    return () => { try { sub.data.subscription.unsubscribe(); } catch {} };
  }, [supabase]);

  const isSignedIn = !!user; 
  const canPost = !requireAuth || isSignedIn; 
  const isAdmin = !!adminCode && adminCode.length >= 4;

  // filters/sort
  const [q, setQ] = useState(''); 
  const [stateFilter, setStateFilter] = useState(''); 
  const [fromDate, setFromDate] = useState(''); 
  const [toDate, setToDate] = useState('');
  const [sort, setSort] = useState<'new'|'old'>('new');

  // data
  const [sightings, setSightings] = useState<Sighting[]>([]); 
  const [loading, setLoading] = useState(false); 
  const [selectedId, setSelectedId] = useState<string|null>(null);

  // form/editing
  const [editing, setEditing] = useState<Sighting | null>(null);
  const [form, setForm] = useState<Partial<Sighting>>({
    city: '', state: '', shape: '', duration: '', summary: '',
    vehicle_make: '', vehicle_model: '', lat: null, lon: null,
    reported_at: null, photo_url: null, address_text: '',
  });
  useEffect(() => {
    if (hydrated && !form.reported_at) {
      setForm(f => ({ ...f, reported_at: new Date().toISOString() }));
    }
  }, [hydrated, form.reported_at]);

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [anonymous, setAnonymous] = useState(false);

  // invite links (?roomId= / ?code=)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    const rid = cleanId(u.searchParams.get('roomId') || '');
    const code = cleanId(u.searchParams.get('code') || '');
    if (rid && !roomId) { setRoomId(rid); storage.set('ufo:room:id', rid); }
    if (code && !roomId) { void joinRoomByCode(code); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // load room meta
  useEffect(() => { if (!roomId) return; (async () => {
    const { data } = await supabase.from('rooms').select('*').eq('id', roomId).maybeSingle();
    if (data) {
      const r = data as RoomRow; setRoomName(r.name ?? ''); setOwnerEmail(r.owner_email ?? '');
      storage.set('ufo:room:name', r.name ?? ''); storage.set('ufo:room:owner', r.owner_email ?? '');
    }
  })(); }, [roomId, supabase, setRoomName, setOwnerEmail]);

  // ===== Loader with request sequencing guard =====
  const reqSeq = useRef(0);
  const loadSightings = async (rid: string) => {
    if (!rid) { setSightings([]); return; } 
    const mySeq = ++reqSeq.current;
    setLoading(true);

    let qy = supabase.from('sightings').select('*').eq('room_id', rid);
    if (q.trim()) qy = qy.ilike('summary', `%${q}%`);
    if (stateFilter) qy = qy.eq('state', stateFilter);
    if (fromDate) qy = qy.gte('reported_at', new Date(fromDate).toISOString());
    if (toDate) { const end = new Date(toDate); end.setHours(23,59,59,999); qy = qy.lte('reported_at', end.toISOString()); }
    qy = qy.order('reported_at', { ascending: sort === 'old' });

    const { data, error } = await qy;
    if (mySeq !== reqSeq.current) return; // ignore stale responses
    if (!error && data) { 
      const rows = data as Sighting[]; 
      setSightings(rows); 
      try { localStore.set?.(rows); } catch {} 
    }
    setLoading(false);
  };

  useEffect(() => { void loadSightings(roomId); }, [roomId, q, stateFilter, fromDate, toDate, sort]); // eslint-disable-line

  const refreshSightings = async () => { if (roomId) await loadSightings(roomId); };

  /* ---------- Broadcast + 8s polling ---------- */
  useEffect(() => {
    if (!roomId) return;
    const ch = supabase.channel(`room-${roomId}`, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'sightings:changed' }, () => { void loadSightings(roomId); });
    ch.subscribe();
    const int = window.setInterval(() => { void loadSightings(roomId); }, 8000);
    return () => { try { supabase.removeChannel(ch); } catch {} window.clearInterval(int); };
  }, [roomId]); // eslint-disable-line

  // Refresh on focus/visibility (mobile)
  useEffect(() => {
    const onWake = () => { void refreshSightings(); };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [roomId]);

  /* ---------- Auth ---------- */
  async function sendMagicLink(email: string) { 
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    setAuthLoading(false); 
    if (error) alert(error.message); else alert('Magic link sent!');
  }
  async function signOut() { await supabase.auth.signOut(); }

  /* ---------- Rooms ---------- */
  async function createRoom(name: string, email?: string) {
    const code = randomCode(6);
    const short = (Math.random().toString(36).slice(-8)).replace(/[^a-z0-9]/g,'');
    const { data, error } = await supabase.from('rooms')
      .insert({ name, owner_email: email ?? null, admin_code: code, short_code: short })
      .select('*').single();
    if (error) return alert(error.message);
    const r = data as RoomRow;
    setRoomId(r.id); setRoomName(r.name ?? ''); setOwnerEmail(r.owner_email ?? ''); setAdminCode(code);
    storage.set('ufo:room:id', r.id); storage.set('ufo:room:name', r.name ?? ''); storage.set('ufo:room:owner', r.owner_email ?? ''); storage.set('ufo:room:admin', code);
    alert(`Room created.\nID: ${r.id}\nCode: ${r.short_code}`);
  }
  async function joinRoomById(idOrCode: string) {
    const input = cleanId(idOrCode);
    let r: RoomRow | null = null;
    const byId = await supabase.from('rooms').select('*').eq('id', input).maybeSingle();
    if (byId.data) r = byId.data as RoomRow;
    if (!r) {
      const byCode = await supabase.from('rooms').select('*').eq('short_code', input).maybeSingle();
      if (byCode.data) r = byCode.data as RoomRow;
    }
    if (!r) return alert('Room ID not found.');
    setRoomId(r.id); setRoomName(r.name ?? ''); setOwnerEmail(r.owner_email ?? '');
    storage.set('ufo:room:id', r.id); storage.set('ufo:room:name', r.name ?? ''); storage.set('ufo:room:owner', r.owner_email ?? '');
    setActiveTab('list');
  }
  async function joinRoomByCode(code: string) { return joinRoomById(code); }
  function leaveRoom() {
    setRoomId(''); setRoomName(''); setOwnerEmail(''); setAdminCode('');
    storage.del('ufo:room:id'); storage.del('ufo:room:name'); storage.del('ufo:room:owner'); storage.del('ufo:room:admin');
    setSightings([]); setSelectedId(null);
  }

  /* ---------- Upload Photo ---------- */
  async function uploadPhotoIfNeeded(): Promise<{ url: string | null; error?: string }> {
    if (!photoFile) return { url: form.photo_url ?? null };
    const bucket = 'sighting-photos';
    const dir = cleanId(roomId || 'room');
    const safeName = cleanFileName(photoFile.name);
    const path = `${dir}/${crypto.randomUUID()}-${safeName}`;
    const { error } = await supabase.storage.from(bucket).upload(path, photoFile, { upsert: false });
    if (error) return { url: form.photo_url ?? null, error: error.message };
    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
    return { url: pub?.publicUrl ?? null };
  }

  /* ---------- Geocoding helpers ---------- */
  async function geocodeAddress(qIn: string) {
    // If the string is short/ambiguous, append City/State from form
    const trimmed = qIn.trim();
    let q = trimmed;
    const city = (form.city ?? '').trim();
    const st = (form.state ?? '').trim();
    const isVague = trimmed.length < 20 && !/[,]/.test(trimmed);
    if (isVague && (city || st)) {
      q = `${trimmed}${city ? `, ${city}` : ''}${st ? `, ${st}` : ''}`;
    }
    const res = await fetch(`/api/geocode?mode=search&q=${encodeURIComponent(q)}`);
    const arr = await res.json();
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }
  async function reverseGeocode(lat: number, lon: number) {
    const res = await fetch(`/api/geocode?mode=reverse&lat=${lat}&lon=${lon}`);
    return await res.json();
  }

  /* ---------- CRUD ---------- */
  async function upsertSighting() {
    if (!roomId) return alert('Set a room in Settings.');
    if (!canPost) return alert('Sign in required to post.');

    const up = await uploadPhotoIfNeeded();
    if (up.error) { alert(`Upload failed: ${up.error}`); return; }
    const photo_url = up.url;

    const payload = {
      room_id: roomId,
      city: (form.city ?? '').trim(),
      state: (form.state ?? '').trim().toUpperCase(),
      shape: (form.shape ?? '').trim() || null,
      duration: (form.duration ?? '').trim() || null,
      summary: (form.summary ?? '').trim(),
      title:  (form.summary ?? '').trim(),          // shim for DBs that require title
      vehicle_make: (form.vehicle_make ?? '').trim() || null,
      vehicle_model: (form.vehicle_model ?? '').trim() || null,
      lat: form.lat ?? null,
      lon: form.lon ?? null,
      lng: form.lon ?? null,                        // some DBs use lng
      reported_at: form.reported_at ?? new Date().toISOString(),
      when_iso:    form.reported_at ?? new Date().toISOString(), // shim
      created_by: anonymous ? null : (sessionEmail || null),
      user_name: anonymous ? 'Anonymous' : (sessionEmail || 'Anonymous'),
      photo_url: photo_url ?? null,
      address_text: (form.address_text ?? '').trim() || null,
    };

    if (!payload.city || !payload.state || !payload.summary) {
      alert('City, State, and Summary are required.');
      return;
    }

    if (editing) {
      const { error } = await supabase.from('sightings').update(payload).eq('id', editing.id);
      if (error) return alert(error.message);
      setEditing(null);
    } else {
      const { error } = await supabase.from('sightings').insert(payload);
      if (error) return alert(error.message);
    }

    await refreshSightings();

    try {
      await supabase.channel(`room-${roomId}`).send({
        type: 'broadcast',
        event: 'sightings:changed',
        payload: { roomId }
      });
    } catch {}

    setForm({
      city:'', state:'', shape:'', duration:'', summary:'',
      vehicle_make:'', vehicle_model:'', lat:null, lon:null,
      reported_at:null, photo_url:null, address_text:''
    });
    setPhotoFile(null);
    setAnonymous(false);
    setActiveTab('list');
  }

  async function deleteSighting(id: string) {
    if (!isAdmin) return alert('Admin code required to delete.');
    if (!confirm('Delete this sighting?')) return;
    const { error } = await supabase.from('sightings').delete().eq('id', id);
    if (error) return alert(error.message);
    try { await supabase.channel(`room-${roomId}`).send({ type:'broadcast', event:'sightings:changed', payload:{ roomId } }); } catch {}
    await refreshSightings();
  }

  const filtered = useMemo(() => sightings, [sightings]);

  /* ---------- Map component (stable layers + draft pin) ---------- */
  function MapPane({
    roomId,
    points,
    selectedId,
    draft,                       // { lat, lon }
    onSelect,
    onMapClick
  }: {
    roomId: string;
    points: Sighting[];
    selectedId: string | null;
    draft?: { lat: number | null; lon: number | null };
    onSelect: (id: string) => void;
    onMapClick: (lat: number, lon: number) => void;
  }) {
    const mapRef = useRef<any>(null);

    // Separate layers so draft never clears sightings
    const sightingsLayerRef = useRef<any | null>(null);
    const draftLayerRef = useRef<any | null>(null);

    const shouldAutofitRef = useRef(true);

    // init map + layers
    useEffect(() => {
      let mounted = true;
      (async () => {
        const L = await loadLeaflet();
        if (!mounted) return;

        if (!mapRef.current) {
          const node = document.getElementById('ufo-map');
          if (!node) return;

          const m = L.map(node).setView([39.5, -98.35], 4);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution:'&copy; OpenStreetMap contributors'
          }).addTo(m);

          sightingsLayerRef.current = L.layerGroup().addTo(m);
          draftLayerRef.current = L.layerGroup().addTo(m);

          const saved = storage.get<{ lat:number; lon:number; zoom:number } | null>(mapStateKey(roomId), null);
          if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && Number.isFinite(saved.zoom)) {
            m.setView([saved.lat, saved.lon], saved.zoom, { animate: false });
            shouldAutofitRef.current = false;
          }

          m.on('moveend zoomend', () => {
            const c = m.getCenter(); const z = m.getZoom();
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
          const saved = storage.get<{ lat:number; lon:number; zoom:number } | null>(mapStateKey(roomId), null);
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

    // Render/refresh sighting markers (points)
    useEffect(() => {
      (async () => {
        await loadLeaflet();
        const m = mapRef.current; if (!m || !sightingsLayerRef.current) return;

        const layer = sightingsLayerRef.current;
        layer.clearLayers();

        const bounds = (window as any).L.latLngBounds([]);

        points.forEach((p) => {
          if (p.lat != null && p.lon != null) {
            const mk = (window as any).L.marker([p.lat, p.lon]);
            mk.on('click', () => onSelect(p.id));
            mk.addTo(layer);
            bounds.extend([p.lat, p.lon]);
          }
        });

        if (points.length && shouldAutofitRef.current) {
          m.fitBounds(bounds.pad(0.2));
          shouldAutofitRef.current = false;
        }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [points]);

    // Render/refresh draft marker (separate layer)
    useEffect(() => {
      (async () => {
        await loadLeaflet();
        const m = mapRef.current; if (!m || !draftLayerRef.current) return;
        const layer = draftLayerRef.current;
        layer.clearLayers();

        if (draft && draft.lat != null && draft.lon != null) {
          const mk = (window as any).L.marker([draft.lat, draft.lon]);
          mk.addTo(layer);
          m.setView([draft.lat, draft.lon], Math.max(m.getZoom(), 15), { animate: true });
          shouldAutofitRef.current = false;
        }
      })();
    }, [draft]);

    // Pan to selected saved sighting
    useEffect(() => {
      const m = mapRef.current;
      if (!m || !selectedId) return;
      const s = points.find((x) => x.id === selectedId);
      if (s && s.lat != null && s.lon != null) {
        m.setView([s.lat, s.lon], Math.max(m.getZoom(), 7), { animate: true });
      }
    }, [selectedId, points]);

    return <div id="ufo-map" className="h-[520px] md:h-[650px] w-full rounded-xl border" />;
  }

  // reverse geocode + set form from map click
  const handleMapClick = async (lat: number, lon: number) => {
    setForm(f => ({ ...f, lat, lon }));
    try {
      const data = await reverseGeocode(lat, lon);
      if (data?.display_name) {
        setForm(f => ({
          ...f, lat, lon,
          address_text: data.display_name,
          city: f.city || data.address?.city || data.address?.town || data.address?.village || '',
          state: f.state || data.address?.state_code || data.address?.state || '',
        }));
      }
    } catch {}
    setActiveTab('compose');
  };

  /* ---------- UI ---------- */
  return (
    <main className="mx-auto max-w-7xl p-4 space-y-4">
      {/* Top bar */}
      <header className="flex items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">UFO Sightings Tracker</h1>
        </div>
        <div className="flex items-center gap-2">
          {isSignedIn ? (
            <>
              <span className="text-sm">Signed in as <span className="font-medium">{sessionEmail}</span></span>
              <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <AuthBox onSend={sendMagicLink} loading={authLoading} />
          )}
        </div>
      </header>

      <p className="text-sm text-gray-500">
        {roomId ? <>Room: <span className="font-medium">{roomName || roomId}</span></> : <em>No room selected (open Settings)</em>}
      </p>

      {/* Tabs */}
      <nav className="flex gap-2">
        {['list','map','compose','settings'].map(t => (
          <button key={t}
            className={`rounded-md border px-3 py-2 text-sm ${activeTab===t ? 'bg-gray-100 font-medium' : 'hover:bg-gray-50'}`}
            onClick={() => setActiveTab(t as any)}
          >
            {t==='list'?'Sightings':t==='map'?'Map':t==='compose'?'Add/Edit':'Settings'}
          </button>
        ))}
      </nav>

      {/* Settings tab */}
      {activeTab==='settings' && (
        <section className="rounded-2xl border p-4 space-y-3">
          <h2 className="font-semibold">Settings</h2>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
            <input className="md:col-span-6 rounded-md border px-3 py-2" placeholder="Join by Room ID (UUID) or Short Code"
              onKeyDown={async (e:any)=>{ if(e.key==='Enter'){ await joinRoomById((e.target as HTMLInputElement).value.trim()); (e.target as HTMLInputElement).value=''; }}}
            />
            <button className="md:col-span-2 rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
              onClick={()=>{
                const v = prompt('Enter Room ID or Short Code'); if (v) void joinRoomById(v.trim());
              }}
            >Join</button>
            <div className="md:col-span-4 flex items-center justify-end">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={requireAuth} onChange={(e)=>setRequireAuth(e.target.checked)} />
                Require sign-in to post
              </label>
            </div>
          </div>
          <div className="rounded-md border p-3">
            <h3 className="font-medium mb-2">Create a Room</h3>
            <RoomCreate onCreate={createRoom} />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-gray-500">Admin code enables Delete in the list tab.</span>
              <button className="text-sm text-red-600 hover:underline" onClick={leaveRoom}>Leave room</button>
            </div>
            <div className="mt-3">
              <AdminBox adminCode={adminCode} setAdminCode={(v)=>{ setAdminCode(v); storage.set('ufo:room:admin', v); }} />
            </div>
            {roomId && <ShareLink roomId={roomId} />}
          </div>
        </section>
      )}

      {/* List tab */}
      {activeTab==='list' && (
        <section className="rounded-2xl border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <div className="flex flex-wrap items-center gap-2">
              <input className="rounded-md border px-3 py-2" placeholder="Search summary…" value={q} onChange={(e)=>setQ(e.target.value)} />
              <input className="w-24 rounded-md border px-3 py-2" placeholder="State" maxLength={2}
                     value={stateFilter} onChange={(e)=>setStateFilter(e.target.value.toUpperCase())}/>
              <input type="date" className="rounded-md border px-3 py-2" value={fromDate} onChange={(e)=>setFromDate(e.target.value)} />
              <input type="date" className="rounded-md border px-3 py-2" value={toDate} onChange={(e)=>setToDate(e.target.value)} />
              <select className="rounded-md border px-3 py-2" value={sort} onChange={(e)=>setSort(e.target.value as any)}>
                <option value="new">Newest</option><option value="old">Oldest</option>
              </select>
            </div>
            <div className="flex items-center gap-3">
              {loading && <span className="text-xs text-gray-500">Loading…</span>}
              <button
                className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={() => { setQ(''); setStateFilter(''); setFromDate(''); setToDate(''); void refreshSightings(); }}
              >
                Clear Filters
              </button>
              <button
                className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={() => refreshSightings()}
              >
                Refresh
              </button>
              <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={()=>downloadCSV(`sightings-${roomName || roomId || 'room'}.csv`, filtered)} disabled={!filtered.length}>
                Export CSV
              </button>
            </div>
          </div>
          {filtered.length===0 ? (
            <p className="px-4 py-6 text-sm text-gray-500">No sightings yet.</p>
          ) : (
            <ul className="divide-y max-h-[650px] overflow-auto">
              {filtered.map(s=>(
                <li key={s.id} className={`p-4 ${selectedId===s.id?'bg-gray-50':''}`} onClick={()=>setSelectedId(s.id)}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm text-gray-500">{s.city}, {s.state} • {fmtDate(s.reported_at)}</div>
                      {s.address_text && <div className="text-xs text-gray-500 mt-0.5">{s.address_text}</div>}
                      <p className="mt-1 break-words">{s.summary}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                        {s.shape && <span>Shape: <b>{s.shape}</b></span>}
                        {s.duration && <span>Duration: <b>{s.duration}</b></span>}
                        {(s.vehicle_make||s.vehicle_model) && <span>Vehicle: <b>{[s.vehicle_make,s.vehicle_model].filter(Boolean).join(' ')}</b></span>}
                        {(s.lat!=null&&s.lon!=null)&& <span>Coords: {s.lat}, {s.lon}</span>}
                        {s.created_by ? <span>By: {s.created_by}</span> : <span>By: Anonymous</span>}
                      </div>
                      {s.photo_url && (
                        <div className="mt-3">
                          <img src={s.photo_url} alt="Sighting" className="max-h-56 rounded-md border" />
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="text-sm text-gray-700 hover:underline"
                        onClick={(e)=>{ e.stopPropagation(); setEditing(s); setActiveTab('compose');
                          setForm({ city:s.city, state:s.state, shape:s.shape??'', duration:s.duration??'', summary:s.summary,
                            vehicle_make:s.vehicle_make??'', vehicle_model:s.vehicle_model??'', lat:s.lat, lon:s.lon,
                            reported_at:s.reported_at, photo_url:s.photo_url ?? null, address_text: s.address_text ?? '' });
                          setPhotoFile(null); setAnonymous(!s.created_by);
                        }}>
                        Edit
                      </button>
                      <button className="text-sm text-red-600 hover:underline" onClick={(e)=>{ e.stopPropagation(); void deleteSighting(s.id); }}>
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Map tab */}
      {activeTab==='map' && (
        <section className="rounded-2xl border p-4">
          <MapPane
            roomId={roomId}
            points={filtered}
            selectedId={selectedId}
            draft={{ lat: form.lat ?? null, lon: form.lon ?? null }}
            onSelect={(id)=>setSelectedId(id)}
            onMapClick={handleMapClick}
          />
          <p className="text-xs text-gray-500 mt-2">Tip: click anywhere on the map to set coordinates and look up the address. Your last zoom is remembered per room.</p>
        </section>
      )}

      {/* Compose tab */}
      {activeTab==='compose' && (
        <section className="rounded-2xl border p-4 space-y-3">
          <h2 className="font-semibold">{editing ? 'Edit Sighting' : 'Add Sighting'}</h2>
          {!canPost && <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">Posting is limited to signed-in users.</p>}

          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <input className="md:col-span-3 rounded-md border px-3 py-2" placeholder="City"
              value={form.city??''} onChange={(e)=>setForm(f=>({...f, city:e.target.value}))} />
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="State" maxLength={2}
              value={form.state??''} onChange={(e)=>setForm(f=>({...f, state:e.target.value.toUpperCase()}))} />
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Vehicle Make (optional)"
              value={form.vehicle_make??''} onChange={(e)=>setForm(f=>({...f, vehicle_make:e.target.value}))} />
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Vehicle Model (optional)"
              value={form.vehicle_model??''} onChange={(e)=>setForm(f=>({...f, vehicle_model:e.target.value}))} />
            <input className="md:col-span-3 rounded-md border px-3 py-2" placeholder="Shape (optional)"
              value={form.shape??''} onChange={(e)=>setForm(f=>({...f, shape:e.target.value}))} />

            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Duration (optional)"
              value={form.duration??''} onChange={(e)=>setForm(f=>({...f, duration:e.target.value}))} />
            <input
              type="datetime-local"
              className="md:col-span-3 rounded-md border px-3 py-2"
              value={toLocalInputValue(form.reported_at)}
              onChange={(e)=>setForm(f=>({...f, reported_at:new Date(e.target.value).toISOString()}))}
            />
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Latitude (optional)"
              value={form.lat ?? ''} onChange={(e)=>setForm(f=>({...f, lat:e.target.value?Number(e.target.value):null}))} />
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Longitude (optional)"
              value={form.lon ?? ''} onChange={(e)=>setForm(f=>({...f, lon:e.target.value?Number(e.target.value):null}))} />

            {/* Address search */}
            <input
              className="md:col-span-6 rounded-md border px-3 py-2"
              placeholder="Address or place (e.g., Post Office, Glen Cove, NY)"
              value={form.address_text ?? ''}
              onChange={(e) => setForm(f => ({ ...f, address_text: e.target.value }))}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && (form.address_text ?? '').trim()) {
                  const top = await geocodeAddress((form.address_text ?? '').trim());
                  if (top) {
                    setForm(f => ({
                      ...f,
                      lat: Number(top.lat),
                      lon: Number(top.lon),
                      address_text: top.display_name || f.address_text || '',
                      city: f.city || top.address?.city || top.address?.town || top.address?.village || '',
                      state: f.state || top.address?.state_code || top.address?.state || '',
                    }));
                    setActiveTab('map');
                  } else {
                    alert('Address not found');
                  }
                }
              }}
            />
            <button
              className="md:col-span-2 rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
              onClick={async () => {
                const q = (form.address_text ?? '').trim();
                if (!q) return;
                const top = await geocodeAddress(q);
                if (top) {
                  setForm(f => ({
                    ...f,
                    lat: Number(top.lat),
                    lon: Number(top.lon),
                    address_text: top.display_name || f.address_text || '',
                    city: f.city || top.address?.city || top.address?.town || top.address?.village || '',
                    state: f.state || top.address?.state_code || top.address?.state || '',
                  }));
                  setActiveTab('map');
                } else {
                  alert('Address not found');
                }
              }}
            >
              Find Address
            </button>

            <textarea className="md:col-span-12 rounded-md border px-3 py-2" placeholder="Summary (what happened?)"
              value={form.summary??''} onChange={(e)=>setForm(f=>({...f, summary:e.target.value}))} rows={4} />

            {/* Photo upload */}
            <div className="md:col-span-12 flex items-center gap-3">
              <input
                id="photo-input"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setPhotoFile(f);
                }}
              />
              <label
                htmlFor="photo-input"
                className="inline-flex items-center rounded-md border px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer"
              >
                Choose Photo
              </label>

              {photoFile ? (
                <>
                  <span className="text-sm truncate max-w-[50ch]">{photoFile.name}</span>
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1 text-xs hover:bg-gray-50"
                    onClick={() => {
                      setPhotoFile(null);
                      const el = document.getElementById('photo-input') as HTMLInputElement | null;
                      if (el) el.value = '';
                    }}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className="text-sm text-gray-500">No file selected</span>
              )}

              {form.photo_url && (
                <a className="ml-auto text-sm underline" href={form.photo_url} target="_blank" rel="noreferrer">
                  current photo
                </a>
              )}
            </div>

            {/* Anonymous */}
            <label className="md:col-span-12 flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={anonymous}
                     onChange={(e) => setAnonymous(e.target.checked)} />
              Report anonymously (don’t include my email)
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
              onClick={upsertSighting} disabled={!canPost}>
              {editing ? 'Save Changes' : 'Add Sighting'}
            </button>
            {editing && (
              <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={()=>{ setEditing(null); setPhotoFile(null); setAnonymous(false);
                  setForm({ city:'', state:'', shape:'', duration:'', summary:'', vehicle_make:'', vehicle_model:'', lat:null, lon:null,
                    reported_at:null, photo_url:null, address_text:'' });
                }}>
                Cancel
              </button>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

/* ---------- Subcomponents ---------- */
function AuthBox({ onSend, loading }: { onSend: (email: string) => void; loading: boolean }) {
  const [email, setEmail] = useState(''); 
  return (
    <div className="flex items-center gap-2">
      <input className="rounded-md border px-3 py-1.5 text-sm" placeholder="you@example.com"
        value={email} onChange={(e)=>setEmail(e.target.value)} onKeyDown={(e)=>{ if(e.key==='Enter') onSend(email); }}/>
      <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
        onClick={()=>onSend(email)} disabled={loading || !email.includes('@')}>
        {loading ? 'Sending…' : 'Email link'}
      </button>
    </div>
  );
}

function RoomCreate({ onCreate }: { onCreate: (name: string, email?: string) => void }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
      <input className="md:col-span-5 rounded-md border px-3 py-2" placeholder="Room name"
        value={name} onChange={(e)=>setName(e.target.value)} />
      <input className="md:col-span-5 rounded-md border px-3 py-2" placeholder="Owner email (optional)"
        value={email} onChange={(e)=>setEmail(e.target.value)} />
      <button className="md:col-span-2 rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
        onClick={()=>onCreate(name.trim(), email.trim() || undefined)} disabled={!name.trim()}>
        Create
      </button>
    </div>
  );
}

function AdminBox({ adminCode, setAdminCode }: { adminCode: string; setAdminCode: (v: string)=>void; }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-sm">Admin code:</label>
      <input className="flex-1 rounded-md border px-3 py-2" placeholder="Enter admin code to enable delete"
        value={adminCode} onChange={(e)=>setAdminCode(e.target.value.trim().toUpperCase())}/>
    </div>
  );
}

function ShareLink({ roomId }: { roomId: string }) {
  if (!roomId) return null;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const linkUuid = `${origin || ''}/?roomId=${roomId}`;
  return (
    <div className="flex items-center gap-2 mt-3">
      <input className="flex-1 rounded-md border px-3 py-2" value={linkUuid} readOnly />
      <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={()=>navigator.clipboard.writeText(linkUuid)}>Copy Link</button>
    </div>
  );
}
