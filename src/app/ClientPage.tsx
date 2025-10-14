// src/app/ClientPage.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
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
  photo_url: string | null;
  color: string | null;
  altitude: string | null;
  speed: string | null;
  direction: string | null;
  witnesses: number | null;
  uap_type: string | null;
  created_at: string;
  updated_at: string | null;
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

/* ---------- Leaflet (CDN) ---------- */
declare global { interface Window { L?: any; __leafletLoading?: boolean; __leafletReady?: boolean; } }
async function loadLeaflet(): Promise<typeof window.L> {
  if (typeof window === 'undefined') throw new Error('SSR');
  if (window.L && window.__leafletReady) return window.L;
  if (window.__leafletLoading) return new Promise(res => {
    const t = setInterval(() => { if (window.L && window.__leafletReady) { clearInterval(t); res(window.L); } }, 50);
  });
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

  // UI state
  const [activeTab, setActiveTab] = useState<'list'|'map'|'compose'|'settings'>('list');
  const [requireAuth, setRequireAuth] = useState<boolean>(() => storage.get('ufo:reqauth', false));
  useEffect(() => storage.set('ufo:reqauth', requireAuth), [requireAuth]);

  // auth state
  const [sessionEmail, setSessionEmail] = useState<string>(''); const [authLoading, setAuthLoading] = useState(false);
  useEffect(() => {
    const sub = supabase.auth.onAuthStateChange((_e, s) => setSessionEmail(s?.user?.email ?? ''));
    supabase.auth.getUser().then(({ data }) => setSessionEmail(data.user?.email ?? ''));
    return () => { try { sub.data.subscription.unsubscribe(); } catch {} };
  }, [supabase]);

  const isSignedIn = !!user; const canPost = !requireAuth || isSignedIn; const isAdmin = !!adminCode && adminCode.length >= 4;

  // filters/sort
  const [q, setQ] = useState(''); const [stateFilter, setStateFilter] = useState(''); const [fromDate, setFromDate] = useState(''); const [toDate, setToDate] = useState('');
  const [sort, setSort] = useState<'new'|'old'>('new');

  // data
  const [sightings, setSightings] = useState<Sighting[]>([]); const [loading, setLoading] = useState(false); const [isPending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string|null>(null);

  // form/editing (includes photo + UFO-specific fields)
  const [editing, setEditing] = useState<Sighting | null>(null);
  const [form, setForm] = useState<Partial<Sighting>>({
    city: '', state: '', shape: '', duration: '', summary: '',
    vehicle_make: '', vehicle_model: '', lat: null, lon: null, reported_at: new Date().toISOString(),
    color: '', altitude: '', speed: '', direction: '', witnesses: null, uap_type: '',
    photo_url: null,
  });
  const [photoFile, setPhotoFile] = useState<File | null>(null);

  // support short-code invite links (?roomId= or ?code=)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    const rid = u.searchParams.get('roomId'); const code = u.searchParams.get('code');
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

  // loader with filters
  const loadSightings = async (rid: string) => {
    if (!rid) { setSightings([]); return; } setLoading(true);
    let qy = supabase.from('sightings').select('*').eq('room_id', rid);
    if (q.trim()) qy = qy.ilike('summary', `%${q}%`);
    if (stateFilter) qy = qy.eq('state', stateFilter);
    if (fromDate) qy = qy.gte('reported_at', new Date(fromDate).toISOString());
    if (toDate) { const end = new Date(toDate); end.setHours(23,59,59,999); qy = qy.lte('reported_at', end.toISOString()); }
    qy = qy.order('reported_at', { ascending: sort === 'old' });
    const { data, error } = await qy;
    if (!error && data) { const rows = data as Sighting[]; setSightings(rows); try { localStore.set?.(rows); } catch {} }
    setLoading(false);
  };
  useEffect(() => { startTransition(() => { void loadSightings(roomId); }); }, [roomId, q, stateFilter, fromDate, toDate, sort]); // eslint-disable-line

  /* ---------- Broadcast + 8s polling (works without DB replication) ---------- */
  useEffect(() => {
    if (!roomId) return;
    const ch = supabase.channel(`room-${roomId}`, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'sightings:changed' }, () => { void loadSightings(roomId); });
    ch.subscribe();
    const int = window.setInterval(() => { void loadSightings(roomId); }, 8000);
    return () => { try { supabase.removeChannel(ch); } catch {} window.clearInterval(int); };
  }, [roomId]); // eslint-disable-line

  /* ---------- Auth ---------- */
  async function sendMagicLink(email: string) { setAuthLoading(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    setAuthLoading(false); if (error) alert(error.message); else alert('Magic link sent!');
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
    // accept UUID or short_code
    let r: RoomRow | null = null;
    const byId = await supabase.from('rooms').select('*').eq('id', idOrCode).maybeSingle();
    if (byId.data) r = byId.data as RoomRow;
    if (!r) {
      const byCode = await supabase.from('rooms').select('*').eq('short_code', idOrCode).maybeSingle();
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
  async function uploadPhotoIfNeeded(): Promise<string | null> {
    if (!photoFile) return form.photo_url ?? null;
    const bucket = 'sighting-photos';
    const path = `${roomId}/${crypto.randomUUID()}-${photoFile.name.replace(/\s+/g,'_')}`;
    const { data, error } = await supabase.storage.from(bucket).upload(path, photoFile, { upsert: false });
    if (error) { alert(`Upload failed: ${error.message}`); return form.photo_url ?? null; }
    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
    return pub?.publicUrl ?? null;
  }

  /* ---------- CRUD ---------- */
  async function upsertSighting() {
    if (!roomId) return alert('Set a room in Settings.');
    if (!canPost) return alert('Sign in required to post.');
    const photo_url = await uploadPhotoIfNeeded();

    const payload = {
      room_id: roomId,
      city: (form.city ?? '').trim(),
      state: (form.state ?? '').trim().toUpperCase(),
      shape: (form.shape ?? '').trim() || null,
      duration: (form.duration ?? '').trim() || null,
      summary: (form.summary ?? '').trim(),
      vehicle_make: (form.vehicle_make ?? '').trim() || null,
      vehicle_model: (form.vehicle_model ?? '').trim() || null,
      lat: form.lat ?? null, lon: form.lon ?? null,
      reported_at: form.reported_at ?? new Date().toISOString(),
      created_by: sessionEmail || null,
      photo_url: photo_url ?? null,
      color: (form.color ?? '').trim() || null,
      altitude: (form.altitude ?? '').trim() || null,
      speed: (form.speed ?? '').trim() || null,
      direction: (form.direction ?? '').trim() || null,
      witnesses: form.witnesses ?? null,
      uap_type: (form.uap_type ?? '').trim() || null,
    };

    if (!payload.city || !payload.state || !payload.summary) return alert('City, State, and Summary are required.');

    if (editing) {
      const { error } = await supabase.from('sightings').update(payload).eq('id', editing.id);
      if (error) return alert(error.message);
      setEditing(null);
    } else {
      const { error } = await supabase.from('sightings').insert(payload);
      if (error) return alert(error.message);
    }

    // broadcast
    try { await supabase.channel(`room-${roomId}`).send({ type:'broadcast', event:'sightings:changed', payload:{ roomId } }); } catch {}

    // reset form
    setForm({ city:'', state:'', shape:'', duration:'', summary:'', vehicle_make:'', vehicle_model:'', lat:null, lon:null,
      reported_at:new Date().toISOString(), color:'', altitude:'', speed:'', direction:'', witnesses:null, uap_type:'', photo_url:null });
    setPhotoFile(null);
    setActiveTab('list');
  }

  async function deleteSighting(id: string) {
    if (!isAdmin) return alert('Admin code required to delete.');
    if (!confirm('Delete this sighting?')) return;
    const { error } = await supabase.from('sightings').delete().eq('id', id);
    if (error) return alert(error.message);
    try { await supabase.channel(`room-${roomId}`).send({ type:'broadcast', event:'sightings:changed', payload:{ roomId } }); } catch {}
  }

  const filtered = useMemo(() => sightings, [sightings]);

  /* ---------- Map component ---------- */
  function MapPane({ points, selectedId, onSelect }: { points: Sighting[]; selectedId: string | null; onSelect: (id: string) => void; }) {
    const mapRef = useRef<any>(null); const marks: any[] = useRef([]) as any;
    useEffect(() => { let mounted = true; (async () => {
      const L = await loadLeaflet(); if (!mounted) return;
      if (!mapRef.current) {
        const node = document.getElementById('ufo-map'); if (!node) return;
        const m = L.map(node).setView([39.5,-98.35], 4);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{ attribution:'&copy; OpenStreetMap' }).addTo(m);
        mapRef.current = m;
      }
    })(); return () => { mounted = false; }; }, []);
    useEffect(() => { (async () => {
      const L = await loadLeaflet(); const m = mapRef.current; if (!m) return;
      marks.forEach(mk => m.removeLayer(mk)); (marks as any).length = 0;
      const bounds = L.latLngBounds([]);
      points.forEach(p => { if (p.lat!=null && p.lon!=null) { const mk = L.marker([p.lat,p.lon]); mk.on('click',()=>onSelect(p.id)); mk.addTo(m); (marks as any).push(mk); bounds.extend([p.lat,p.lon]); }});
      if ((marks as any).length) m.fitBounds(bounds.pad(0.2));
    })(); }, [points, onSelect]);
    useEffect(() => { const m = mapRef.current; if (!m || !selectedId) return;
      const s = points.find(x => x.id===selectedId); if (s && s.lat!=null && s.lon!=null) m.setView([s.lat,s.lon], Math.max(m.getZoom(),7), { animate:true });
    }, [selectedId, points]);
    return <div id="ufo-map" className="h-[520px] md:h-[650px] w-full rounded-xl border" />;
  }

  /* ---------- UI ---------- */
  return (
    <main className="mx-auto max-w-7xl p-4 space-y-4">
      {/* Top bar */}
      <header className="flex items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">UFO Sightings Tracker</h1>
          <p className="text-sm text-gray-500 mt-1">
            {roomId ? <>Room: <span className="font-medium">{roomName || roomId}</span></> : <em>No room selected (open Settings)</em>}
          </p>
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
              {(loading || isPending) && <span className="text-xs text-gray-500">Loading…</span>}
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
                      <p className="mt-1 break-words">{s.summary}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                        {s.shape && <span>Shape: <b>{s.shape}</b></span>}
                        {s.duration && <span>Duration: <b>{s.duration}</b></span>}
                        {(s.vehicle_make||s.vehicle_model) && <span>Vehicle: <b>{[s.vehicle_make,s.vehicle_model].filter(Boolean).join(' ')}</b></span>}
                        {s.color && <span>Color: <b>{s.color}</b></span>}
                        {s.uap_type && <span>Type: <b>{s.uap_type}</b></span>}
                        {(s.lat!=null&&s.lon!=null)&& <span>Coords: {s.lat}, {s.lon}</span>}
                        {s.created_by && <span>By: {s.created_by}</span>}
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
                            reported_at:s.reported_at, photo_url:s.photo_url ?? null, color:s.color??'', altitude:s.altitude??'',
                            speed:s.speed??'', direction:s.direction??'', witnesses:s.witnesses??null, uap_type:s.uap_type??'' });
                          setPhotoFile(null);
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
          <MapPane points={filtered} selectedId={selectedId} onSelect={(id)=>setSelectedId(id)} />
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
            <input type="datetime-local" className="md:col-span-3 rounded-md border px-3 py-2"
              value={form.reported_at ? new Date(form.reported_at).toISOString().slice(0,16) : new Date().toISOString().slice(0,16)}
              onChange={(e)=>setForm(f=>({...f, reported_at:new Date(e.target.value).toISOString()}))} />
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Latitude (optional)"
              value={form.lat ?? ''} onChange={(e)=>setForm(f=>({...f, lat:e.target.value?Number(e.target.value):null}))} />
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Longitude (optional)"
              value={form.lon ?? ''} onChange={(e)=>setForm(f=>({...f, lon:e.target.value?Number(e.target.value):null}))} />

            {/* UFO fields */}
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Color" value={form.color??''}
              onChange={(e)=>setForm(f=>({...f, color:e.target.value}))}/>
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Altitude" value={form.altitude??''}
              onChange={(e)=>setForm(f=>({...f, altitude:e.target.value}))}/>
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Speed" value={form.speed??''}
              onChange={(e)=>setForm(f=>({...f, speed:e.target.value}))}/>
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Direction" value={form.direction??''}
              onChange={(e)=>setForm(f=>({...f, direction:e.target.value}))}/>
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="Witnesses" type="number" min={0}
              value={form.witnesses ?? ''} onChange={(e)=>setForm(f=>({...f, witnesses:e.target.value?Number(e.target.value):null}))}/>
            <input className="md:col-span-2 rounded-md border px-3 py-2" placeholder="UAP Type (e.g., orb, triangle)" value={form.uap_type??''}
              onChange={(e)=>setForm(f=>({...f, uap_type:e.target.value}))}/>

            <textarea className="md:col-span-12 rounded-md border px-3 py-2" placeholder="Summary (what happened?)"
              value={form.summary??''} onChange={(e)=>setForm(f=>({...f, summary:e.target.value}))} rows={4} />

            {/* Photo upload */}
            <div className="md:col-span-12 flex items-center gap-3">
              <input type="file" accept="image/*" onChange={(e)=>setPhotoFile(e.target.files?.[0] ?? null)} />
              {form.photo_url && <a className="text-sm underline" href={form.photo_url} target="_blank" rel="noreferrer">current photo</a>}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
              onClick={upsertSighting} disabled={!canPost}>
              {editing ? 'Save Changes' : 'Add Sighting'}
            </button>
            {editing && (
              <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={()=>{ setEditing(null); setPhotoFile(null);
                  setForm({ city:'', state:'', shape:'', duration:'', summary:'', vehicle_make:'', vehicle_model:'', lat:null, lon:null,
                    reported_at:new Date().toISOString(), color:'', altitude:'', speed:'', direction:'', witnesses:null, uap_type:'', photo_url:null });
                }}>
                Cancel
              </button>
            )}
          </div>
        </section>
      )}

      {/* schema notes */}
      <details className="rounded-2xl border p-4 text-sm text-gray-600">
        <summary className="cursor-pointer font-medium">Schema & Storage notes</summary>
        <pre className="mt-3 whitespace-pre-wrap">
{`Make sure you've created bucket "sighting-photos" in Supabase Storage (public ON).`}
        </pre>
      </details>
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
  const linkCode = `${origin || ''}/?code=${roomId.slice(0,8)}`; // not exact short_code, but quick share; prefer short_code in DB
  return (
    <div className="flex flex-col gap-2 mt-3">
      <div className="flex items-center gap-2">
        <input className="flex-1 rounded-md border px-3 py-2" value={linkUuid} readOnly />
        <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={()=>navigator.clipboard.writeText(linkUuid)}>Copy UUID Link</button>
      </div>
      <div className="flex items-center gap-2">
        <input className="flex-1 rounded-md border px-3 py-2" value={linkCode} readOnly />
        <button className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50" onClick={()=>navigator.clipboard.writeText(linkCode)}>Copy Short Link</button>
      </div>
    </div>
  );
}
