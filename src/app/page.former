"use client";

import React, { useEffect, useMemo, useState } from "react";
import InstallPWA from "./install-pwa";
import dynamic from "next/dynamic";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import { format } from "date-fns";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Toaster, toast } from "sonner";
import { Settings, Share2, Trash } from "lucide-react";
function getLocalDateTimeInputValue() {
  // Builds YYYY-MM-DDTHH:MM in the user's local time zone
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000; // minutes -> ms
  const local = new Date(now.getTime() - offsetMs);
  return local.toISOString().slice(0, 16);
}
// Map is client-only (prevents "window is not defined")
const LocationPicker = dynamic(() => import("./Map").then(m => m.LocationPicker), { ssr: false });
const SightingsMap  = dynamic(() => import("./Map").then(m => m.SightingsMap),  { ssr: false });

// ---------------- Helpers ----------------
const storage = {
  get<T = any>(key: string, fallback: T): T {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(key) : null;
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch { return fallback; }
  },
  set(key: string, val: any) {
    try { if (typeof window !== "undefined") localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
};

// ---------------- Types ----------------
type Sighting = {
  id: string;
  created_at?: string;
  room_id: string;
  user_name: string;
  title: string;
  notes: string;
  lat: number;
  lng: number;
  when_iso: string;
  address?: string;
  media_url?: string | null;
  upvotes: number;
  shape?: string;
  color?: string;
};

// ---------------- Supabase (optional) ----------------
function useSupabase() {
  const [url, setUrl]       = useState<string>("");
  const [key, setKey]       = useState<string>("");
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [user, setUser]     = useState<any>(null);

  // load after mount (avoid hydration mismatch)
  useEffect(() => {
    setUrl(storage.get("ufo:supa:url", ""));
    setKey(storage.get("ufo:supa:key", ""));
  }, []);

  useEffect(() => {
    if (url && key) {
      const c = createClient(url, key);
      setClient(c);
      c.auth.getUser().then(({ data }) => setUser(data?.user || null));
      const { data: sub } = c.auth.onAuthStateChange((_e, sess) => setUser(sess?.user || null));
      return () => sub?.subscription?.unsubscribe?.();
    } else {
      setClient(null);
      setUser(null);
    }
  }, [url, key]);

  useEffect(() => { storage.set("ufo:supa:url", url); }, [url]);
  useEffect(() => { storage.set("ufo:supa:key", key); }, [key]);

  return { url, key, setUrl, setKey, client, user };
}

// ---------------- Room info ----------------
function useRoom() {
  const [roomId, setRoomId]         = useState<string>("");
  const [roomName, setRoomName]     = useState<string>("My UFO Circle");
  const [ownerEmail, setOwnerEmail] = useState<string>("");
  const [adminCode, setAdminCode]   = useState<string>("");

  // load after mount to avoid hydration mismatch
  useEffect(() => {
    const initialId = storage.get("ufo:room:id", "") || uuidv4().slice(0, 8);
    setRoomId(initialId);
    setRoomName(storage.get("ufo:room:name", "My UFO Circle"));
    setOwnerEmail(storage.get("ufo:room:owner", ""));
    setAdminCode(storage.get("ufo:room:code", ""));
  }, []);

  // persist
  useEffect(() => { if (roomId) storage.set("ufo:room:id", roomId); }, [roomId]);
  useEffect(() => { storage.set("ufo:room:name", roomName); }, [roomName]);
  useEffect(() => { storage.set("ufo:room:owner", ownerEmail); }, [ownerEmail]);
  useEffect(() => { storage.set("ufo:room:code", adminCode); }, [adminCode]);

  return { roomId, setRoomId, roomName, setRoomName, ownerEmail, setOwnerEmail, adminCode, setAdminCode };
}

// ---------------- Local store (offline) ----------------
function useLocalSightings(roomId: string) {
  const key = `ufo:sightings:${roomId}`;
  function getAll(): Sighting[] { return storage.get(key, [] as Sighting[]); }
  function setAll(list: Sighting[]) { storage.set(key, list); }
  return {
    async list() { return getAll(); },
    async upsert(s: Sighting) {
      const all = getAll();
      const i = all.findIndex(x => x.id === s.id);
      if (i >= 0) all[i] = s; else all.unshift(s);
      setAll(all); return s;
    },
    async remove(id: string) {
      const all = getAll().filter(x => x.id !== id);
      setAll(all);
    },
    async vote(id: string, delta: number) {
      const all = getAll();
      const i = all.findIndex(x => x.id === id);
      if (i >= 0) { all[i].upvotes = (all[i].upvotes || 0) + delta; setAll(all); return all[i]; }
    }
  };
}

// ---------------- Remote store (Supabase) ----------------
function useRemoteSightings(client: SupabaseClient | null, roomId: string, onRealtime: () => void) {
  return useMemo(() => {
    if (!client) return null;
    return {
      async list() {
        const { data, error } = await client
          .from("sightings")
          .select("*")
          .eq("room_id", roomId)
          .order("when_iso", { ascending: false });
        if (error) throw error; return (data as Sighting[]) || [];
      },
      async upsert(s: Sighting) {
        const { data, error } = await client.from("sightings").upsert(s).select().single();
        if (error) throw error; return data as Sighting;
      },
      async remove(id: string) {
        const { error } = await client.from("sightings").delete().eq("id", id);
        if (error) throw error;
      },
      async vote(id: string, delta: number) {
        const { data, error } = await client.rpc("vote_sighting", { p_id: id, p_delta: delta });
        if (error) throw error; return data;
      },
      subscribe() {
        const ch = client
          .channel(`sightings-${roomId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "sightings", filter: `room_id=eq.${roomId}` }, () => onRealtime?.())
          .subscribe();
        return () => { client.removeChannel(ch); };
      },
      async uploadMedia(file: File, room: string) {
        const ext = file.name.split(".").pop();
        const path = `${room}/${uuidv4()}.${ext}`;
        const { error } = await client.storage.from("media").upload(path, file, { upsert: false, cacheControl: "3600" });
        if (error) throw error;
        const { data } = client.storage.from("media").getPublicUrl(path);
        return data.publicUrl as string;
      }
    };
  }, [client, roomId, onRealtime]);
}

// ---------------- Simple spam guard ----------------
const submitTimes: number[] = [];
function canSubmitNow() {
  const now = Date.now();
  while (submitTimes.length && now - submitTimes[0] > 5 * 60 * 1000) submitTimes.shift();
  return submitTimes.length < 3; // max 3 per 5 minutes
}
function recordSubmit() { submitTimes.push(Date.now()); }
const BANNED = ["buy now", "free money", "crypto airdrop"];

// ---------------- Geocoding helpers (OpenStreetMap Nominatim) ----------------
async function geocodeAddress(addr: string): Promise<[number, number] | null> {
  if (!addr.trim()) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(addr)}&limit=1`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) return null;
  return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
}

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.display_name || null;
}

// ---------------- Sighting Form ----------------
// --- Sighting Form ------------------------------------------------
function SightingForm({ onSubmit, uploadMedia, requireAuth, isAuthed }) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [shape, setShape] = useState("");
  const [color, setColor] = useState("");
  const [whenISO, setWhenISO] = useState(""); // will be set in useEffect
  const [coords, setCoords] = useState/** @type {[number, number] | null} */(null);
  const [media, setMedia] = useState("");
  const [file, setFile] = useState/** @type {File|null} */(null);
  const [name, setName] = useState(() => storage.get("ufo:user:name", ""));
  const [address, setAddress] = useState("");

  // ✅ Set current date/time on mount
 useEffect(() => {
 setWhenISO(getLocalDateTimeInputValue());
}, []);

  useEffect(() => { storage.set("ufo:user:name", name); }, [name]);

  return (
    <Card className="shadow-lg">
      <CardHeader>
        <CardTitle className="text-xl">Report a Sighting</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {requireAuth && !isAuthed && (
          <div className="rounded-xl border p-3 text-sm bg-amber-50">
            Please sign in (Settings → Sign In) to report.
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>Your name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g., Roger" />
          </div>
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Bright light over park" />
          </div>
          <div>
            <Label>When</Label>
            <Input
              type="datetime-local"
              value={whenISO}
              onChange={e => setWhenISO(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Shape</Label>
              <select className="border rounded-md h-10 px-2 w-full" value={shape} onChange={e => setShape(e.target.value)}>
                <option value="">—</option>
                <option>Disc</option>
                <option>Cigar</option>
                <option>Triangle</option>
                <option>Lights</option>
                <option>Other</option>
              </select>
            </div>
            <div>
              <Label>Color</Label>
              <select className="border rounded-md h-10 px-2 w-full" value={color} onChange={e => setColor(e.target.value)}>
                <option value="">—</option>
                <option>White</option>
                <option>Orange</option>
                <option>Red</option>
                <option>Blue</option>
                <option>Green</option>
                <option>Multi</option>
              </select>
            </div>
          </div>

          <div className="md:col-span-2">
            <Label>Notes</Label>
            <Textarea
              rows={4}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Describe movement, color, duration, witnesses…"
            />
          </div>

          <div className="md:col-span-2">
<Label>Location name or address (optional)</Label>
<Input
  value={address}
  onChange={e => setAddress(e.target.value)}
  placeholder="e.g., Post Office, Glen Cove, NY or Starbucks on Main St"
/>

          </div>

          <div>
            <Label>Photo / video URL (optional)</Label>
            <Input value={media} onChange={e => setMedia(e.target.value)} placeholder="https://…" />
          </div>

          <div>
            <Label>Or upload media (Supabase)</Label>
            <input
              type="file"
              accept="image/*,video/*"
              onChange={e => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Location</Label>
            <span className="text-xs text-muted-foreground">Click the map or enter an address</span>
          </div>

          <LocationPicker value={coords} onChange={setCoords} />
          {coords && (
            <div className="text-sm text-muted-foreground">
              Lat {coords[0].toFixed(5)}, Lng {coords[1].toFixed(5)}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setTitle("");
              setNotes("");
              setMedia("");
              setCoords(null);
              setShape("");
              setColor("");
              setFile(null);
              setAddress("");
              // ✅ Reset time to now (Eastern Time)when clearing
              setWhenISO(getLocalDateTimeInputValue());
            }}
          >
            Clear
          </Button>

          <Button
            onClick={async () => {
              if (!title || !whenISO || (!coords && !address.trim()))
                return onSubmit?.(null, "Please provide a title, time, and either click the map or enter an address.");

              if (notes && BANNED.some(w => notes.toLowerCase().includes(w)))
                return onSubmit?.(null, "Notes contain blocked terms.");

              if (!canSubmitNow())
                return onSubmit?.(null, "Rate limit: max 3 reports per 5 minutes.");

              let finalCoords = coords;
              if (!finalCoords && address.trim()) {
                const gc = await geocodeAddress(address.trim());
                if (!gc) return onSubmit?.(null, "Couldn't find that address. Try a more exact street & city.");
                finalCoords = gc;
                setCoords(gc);
              }

              let mediaUrl = media || "";
              if (!mediaUrl && file && uploadMedia) {
                try {
                  mediaUrl = await uploadMedia(file);
                } catch (e) {
                  return onSubmit?.(null, "Upload failed: " + (e?.message || e));
                }
              }

              onSubmit?.({
                id: uuidv4(),
                room_id: "",
                user_name: name || "Anonymous",
                title,
                notes,
                lat: finalCoords[0],
                lng: finalCoords[1],
                when_iso: new Date(whenISO).toISOString(),
                media_url: mediaUrl || null,
                upvotes: 0,
                shape,
                color,
                address,
              });
            }}
          >
            Submit
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
// ---------------- Sighting Item ----------------
function SightingItem({ s, onVote, onDelete }: { s: Sighting; onVote: (id: string, d: number) => void; onDelete: (id: string) => void }) {
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="hover:shadow-xl transition-shadow">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{s.title}</CardTitle>
            <div className="flex items-center gap-2">
              {s.shape && <Badge variant="secondary">{s.shape}</Badge>}
              {s.color && <Badge variant="outline">{s.color}</Badge>}
              <Badge variant="secondary">{format(new Date(s.when_iso), "PPp")}</Badge>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon"><Trash className="h-4 w-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => onDelete?.(s.id)} className="text-red-600">Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            Reported by {s.user_name} • ({s.lat.toFixed(3)}, {s.lng.toFixed(3)}){s.address ? ` • ${s.address}` : ""}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{s.notes}</p>
          {s.media_url && (
            <a href={s.media_url} target="_blank" rel="noreferrer" className="block rounded-xl overflow-hidden border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.media_url} alt="evidence" className="w-full max-h-80 object-cover" />
            </a>
          )}
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => onVote?.(s.id, +1)}>▲ Upvote</Button>
              <Button size="sm" variant="secondary" onClick={() => onVote?.(s.id, -1)}>▼ Downvote</Button>
            </div>
            <Badge>{s.upvotes ?? 0} points</Badge>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ---------------- CSV Export ----------------
function exportCSV(rows: Sighting[]) {
  const headers = [
    "id","room_id","user_name","title","notes",
    "lat","lng","when_iso","address","media_url",
    "upvotes","shape","color"
  ];
  const body = rows.map(r =>
    headers.map(h => (r as any)[h] !== undefined && (r as any)[h] !== null ? String((r as any)[h]).replace(/"/g, '""') : "")
  );
  const csv = [headers.join(","), ...body.map(r => `"${r.join('","')}"`)].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `ufo-sightings-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ---------------- Main App ----------------
export default function App() {
  const { url, key, setUrl, setKey, client, user } = useSupabase();
  const { roomId, setRoomId, roomName, setRoomName, ownerEmail, setOwnerEmail, adminCode, setAdminCode } = useRoom();
  const [tab, setTab] = useState("map");

  const [requireAuth, setRequireAuth] = useState<boolean>(false);
  useEffect(() => { setRequireAuth(storage.get("ufo:room:reqauth", false)); }, []);
  useEffect(() => storage.set("ufo:room:reqauth", requireAuth), [requireAuth]);

  const localStore = useLocalSightings(roomId);
  const remoteStore = useRemoteSightings(client, roomId, () => reload());
  const store: any = remoteStore || localStore;

  const [list, setList] = useState<Sighting[]>([]);
  const [loading, setLoading] = useState(false);

  // Build invite URL safely on the client only
  const [inviteUrl, setInviteUrl] = useState("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (roomId) u.searchParams.set("room", roomId);
    setInviteUrl(u.toString());
  }, [roomId]);

  async function reload() {
    setLoading(true);
    try {
      const rows = await store.list();
      setList(rows);
    } catch (e: any) {
      console.error(e);
      toast.error("Load failed", { description: String(e?.message || e) });
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (!roomId) return; // wait until room loaded
    reload();
    if (remoteStore?.subscribe) {
      const unsub = remoteStore.subscribe();
      return () => unsub?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, client]);

  async function createSighting(base: Partial<Sighting> | null, errMsg?: string) {
  if (!base) {
    return toast.error("Missing info", { description: errMsg || "Please fill required fields." });
  }
  const s = { ...(base as Sighting), room_id: roomId };

  try {
    // save to local or Supabase (depending on your Settings)
    await store.upsert(s);
    recordSubmit();

    // ✅ NEW: trigger email notifications (does not block the UI if it fails)
    fetch("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // this matches the simplified route.ts we created
        title: s.title,
        notes: s.notes,
        room_id: roomId,
      }),
    }).catch(() => { /* ignore notify failures so save still succeeds */ });

    // existing UI flow
    toast.success("Sighting logged", { description: "Shared with your circle." });
    reload();
  } catch (e: any) {
    console.error(e);
    toast.error("Save failed", { description: String(e?.message || e) });
  }
}
  async function vote(id: string, delta: number) {
    try { await store.vote(id, delta); reload(); } catch { reload(); }
  }

  async function remove(id: string) {
    if (user?.email && ownerEmail && user.email === ownerEmail) {
      // allowed
    } else if (adminCode) {
      const code = typeof window !== "undefined" ? window.prompt("Enter admin code to delete") : "";
      if (code !== adminCode) return toast.error("Not authorized", { description: "Incorrect admin code." });
    } else if (requireAuth) {
      return toast.error("Not authorized", { description: "Only the owner can delete." });
    }
    try { await store.remove(id); reload(); }
    catch (e: any) { toast.error("Delete failed", { description: String(e?.message || e) }); }
  }

  // Read ?room=... on mount (client-only)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const r = params.get("room");
    if (r) setRoomId(r);
  }, [setRoomId]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <header className="sticky top-0 z-20 backdrop-blur bg-white/70 border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🛸</span>
            <div>
              <div className="text-xl font-semibold">{roomName}</div>
              <div className="text-xs text-muted-foreground">Room ID: {roomId || "—"}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary" size="sm"><Settings className="h-4 w-4 mr-1" /> Settings</Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                  <DialogTitle>Circle, Auth & Backend</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <Label>Circle name</Label>
                      <Input value={roomName} onChange={e => setRoomName(e.target.value)} />
                    </div>
                    <div>
                      <Label>Room ID</Label>
                      <div className="flex gap-2">
                        <Input value={roomId} onChange={e => setRoomId(e.target.value.trim())} />
                        <Button variant="outline" onClick={() => { const r = uuidv4().slice(0, 8); setRoomId(r); }}>
                          New
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <Label>Owner email (optional)</Label>
                      <Input value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} placeholder="owner@you.com" />
                      <p className="text-xs text-muted-foreground mt-1">If set, that signed-in user bypasses admin code for deletes.</p>
                    </div>
                    <div>
                      <Label>Admin code (optional)</Label>
                      <Input value={adminCode} onChange={e => setAdminCode(e.target.value)} placeholder="e.g., moonbeam-42" />
                    </div>
                  </div>

                  <div className="rounded-xl border p-3 bg-slate-50 space-y-2">
                    <div className="font-medium">Auth (Supabase magic link)</div>
                    <AuthControls client={client} />
                    <div className="flex items-center gap-3 mt-2">
                      <input type="checkbox" id="req" checked={requireAuth} onChange={e => setRequireAuth(e.target.checked)} />
                      <Label htmlFor="req">Require sign-in to post</Label>
                    </div>
                  </div>

                  <div className="rounded-xl border p-3 bg-slate-50">
                    <div className="font-medium mb-2">Optional: Connect Supabase (for realtime + storage)</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <Label>Supabase URL</Label>
                        <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://YOUR-PROJECT.supabase.co" />
                      </div>
                      <div>
                        <Label>Anon key</Label>
                        <Input value={key} onChange={e => setKey(e.target.value)} placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…" />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Leave blank to use private, device-only storage. Fill both fields to enable cloud sync and multi-user rooms. Storage bucket name expected: <code>media</code>.
                    </p>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            <Button size="sm" onClick={async () => {
              await navigator.clipboard.writeText(inviteUrl);
              toast.success("Invite copied", { description: "Share this link so friends join your circle." });
            }}>
              <Share2 className="h-4 w-4 mr-1" /> Invite
            </Button>
            <Button size="sm" variant="outline" onClick={() => exportCSV(list)}>Export CSV</Button>
             <InstallPWA />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="map">Map</TabsTrigger>
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="report">Report</TabsTrigger>
          </TabsList>

          <TabsContent value="map" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Map of Sightings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <SightingsMap list={list} />
                <div className="text-xs text-muted-foreground">Showing {list.length} sightings. {loading ? "Refreshing…" : ""}</div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="list" className="mt-4">
            <div className="grid md:grid-cols-2 gap-4">
              {list.map(s => (
                <SightingItem key={s.id} s={s} onVote={vote} onDelete={remove} />
              ))}
              {!list.length && (
                <Card className="col-span-full">
                  <CardContent className="py-12 text-center text-muted-foreground">
                    No sightings yet. Head to <Badge>Report</Badge> to add your first!
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="report" className="mt-4">
            <SightingForm
              onSubmit={createSighting}
              uploadMedia={remoteStore?.uploadMedia ? (file: File) => remoteStore.uploadMedia(file, roomId) : undefined}
              requireAuth={requireAuth}
              isAuthed={!!user}
            />
          </TabsContent>
        </Tabs>

        <footer className="text-center text-xs text-muted-foreground pt-6">
          Built with ❤️ for curious sky-watchers. Your data stays on your device unless you connect Supabase.
        </footer>
      </main>

      <Toaster richColors position="top-right" />
    </div>
  );
}

function AuthControls({ client }: { client: SupabaseClient | null }) {
  const [email, setEmail]   = useState("");
  const [status, setStatus] = useState("");
  const [current, setCurrent] = useState<any>(null);

  useEffect(() => {
    if (!client) return;
    client.auth.getUser().then(({ data }) => setCurrent(data?.user || null));
    const { data } = client.auth.onAuthStateChange((_e, sess) => setCurrent(sess?.user || null));
    return () => data?.subscription?.unsubscribe?.();
  }, [client]);

  if (!client) return <div className="text-sm text-muted-foreground">Connect Supabase to enable sign-in.</div>;

  return (
    <div className="flex flex-col gap-2">
      {current ? (
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Signed in</Badge>
          <span className="text-sm">{current.email}</span>
          <Button size="sm" variant="outline" onClick={() => client.auth.signOut()}>Sign Out</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <Label>Email</Label>
            <Input type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <Button size="sm" onClick={async () => {
            setStatus("Sending magic link…");
            const redirectTo = typeof window !== "undefined" ? window.location.href : "";
            const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
            setStatus(error ? String(error.message || error) : "Check your email for the link.");
          }}>Send Link</Button>
          {status && <div className="text-xs text-muted-foreground">{status}</div>}
        </div>
      )}
    </div>
  );
}

/* --------------------- SUPABASE SQL (optional) ---------------------
If you enable Supabase, add an address column:

alter table public.sightings add column if not exists address text;

-- or full create:
create table if not exists public.sightings (
  id uuid primary key,
  created_at timestamptz default now(),
  room_id text not null,
  user_name text not null,
  title text not null,
  notes text,
  lat double precision not null,
  lng double precision not null,
  when_iso timestamptz not null,
  address text,
  media_url text,
  upvotes integer not null default 0,
  shape text,
  color text
);
create index if not exists idx_sightings_room on public.sightings(room_id);

create or replace function public.vote_sighting(p_id uuid, p_delta integer)
returns void language sql as $$
  update public.sightings set upvotes = greatest(0, upvotes + p_delta) where id = p_id;
$$;

alter publication supabase_realtime add table public.sightings;
*/
