"use client";

import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import { format } from "date-fns";
import { Toaster, toast } from "sonner";

// shadcn/ui
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Settings, Share2, Trash } from "lucide-react";

/* ===========================
   Types
=========================== */
type Sighting = {
  id: string;
  created_at?: string;
  room_id: string;
  user_name: string;
  title: string;
  notes?: string;
  lat: number;
  lng: number;
  when_iso: string;
  media_url?: string | null;
  upvotes: number;
  shape?: string;
  color?: string;
  // vehicle (optional columns in your DB)
  car_make?: string | null;
  car_model?: string | null;
};

type Member = {
  id: string;
  email: string;
  room_id: string;
  status: "pending" | "approved" | "blocked";
  role: "user" | "admin";
  wants_email?: boolean | null;
  wants_sms?: boolean | null;
  phone?: string | null;
};

/* ===========================
   Utilities
=========================== */
const storage = {
  get<T = any>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, val: any) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  },
};

// datetime-local helper (local time, not UTC)
function localInputNow() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function nl<T>(v: T | undefined | null, alt = ""): T | string {
  return v == null ? alt : (v as any);
}

/* ===========================
   Map (loaded client-side)
=========================== */
const LocationPicker = dynamic(() => import("./Map").then(m => m.LocationPicker), {
  ssr: false,
  loading: () => (
    <div className="h-64 rounded-xl border flex items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

const SightingsMap = dynamic(() => import("./Map").then(m => m.SightingsMap), {
  ssr: false,
  loading: () => (
    <div className="h-[420px] rounded-xl border flex items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

/* ===========================
   Supabase client & hooks
=========================== */
function useSupabase() {
  const [url, setUrl] = useState(() =>
    storage.get<string>("ufo:supa:url", process.env.NEXT_PUBLIC_SUPABASE_URL || "")
  );
  const [key, setKey] = useState(() =>
    storage.get<string>("ufo:supa:key", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "")
  );
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [user, setUser] = useState<any>(null);

  useEffect(() => storage.set("ufo:supa:url", url), [url]);
  useEffect(() => storage.set("ufo:supa:key", key), [key]);

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

  return { url, key, setUrl, setKey, client, user };
}

function useRoom() {
  const defaultRoom = process.env.NEXT_PUBLIC_DEFAULT_ROOM_ID || uuidv4().slice(0, 8);
  const [roomId, setRoomId] = useState(() => storage.get<string>("ufo:room:id", defaultRoom));
  const [roomName, setRoomName] = useState(() =>
    storage.get<string>("ufo:room:name", "My UFO Circle")
  );
  const [ownerEmail, setOwnerEmail] = useState(() => storage.get<string>("ufo:room:owner", ""));
  const [adminCode, setAdminCode] = useState(() => storage.get<string>("ufo:room:code", ""));

  useEffect(() => storage.set("ufo:room:id", roomId), [roomId]);
  useEffect(() => storage.set("ufo:room:name", roomName), [roomName]);
  useEffect(() => storage.set("ufo:room:owner", ownerEmail), [ownerEmail]);
  useEffect(() => storage.set("ufo:room:code", adminCode), [adminCode]);

  // Allow joining a circle by URL ?room=xxxx
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const r = params.get("room");
    if (r) setRoomId(r);
  }, [setRoomId]);

  return {
    roomId,
    setRoomId,
    roomName,
    setRoomName,
    ownerEmail,
    setOwnerEmail,
    adminCode,
    setAdminCode,
  };
}

/* ===========================
   Local storage fallback
=========================== */
function useLocalSightings(roomId: string) {
  const key = `ufo:sightings:${roomId}`;
  const getAll = () => storage.get<Sighting[]>(key, []);
  const setAll = (rows: Sighting[]) => storage.set(key, rows);

  return {
    async list() {
      return getAll();
    },
    async upsert(s: Sighting) {
      const all = getAll();
      const i = all.findIndex(x => x.id === s.id);
      if (i >= 0) all[i] = s;
      else all.unshift(s);
      setAll(all);
      return s;
    },
    async remove(id: string) {
      setAll(getAll().filter(x => x.id !== id));
    },
    async vote(id: string, delta: number) {
      const all = getAll();
      const i = all.findIndex(x => x.id === id);
      if (i >= 0) {
        all[i].upvotes = (all[i].upvotes || 0) + delta;
        setAll(all);
        return all[i];
      }
    },
    async uploadMedia(_file: File) {
      // no-op in local mode
      throw new Error("Media upload requires Supabase connection.");
    },
  };
}

function useRemoteSightings(
  client: SupabaseClient | null,
  roomId: string,
  onRealtime?: () => void
) {
  return useMemo(() => {
    if (!client) return null;
    return {
      async list(): Promise<Sighting[]> {
        const { data, error } = await client
          .from("sightings")
          .select("*")
          .eq("room_id", roomId)
          .order("when_iso", { ascending: false });
        if (error) throw error;
        return (data as any) || [];
      },
      async upsert(s: Sighting) {
        const { data, error } = await client.from("sightings").upsert(s).select().single();
        if (error) throw error;
        return data as Sighting;
      },
      async remove(id: string) {
        const { error } = await client.from("sightings").delete().eq("id", id);
        if (error) throw error;
      },
      async vote(id: string, delta: number) {
        const { error } = await client.rpc("vote_sighting", { p_id: id, p_delta: delta });
        if (error) throw error;
      },
      subscribe() {
        const ch = client
          .channel(`sightings-${roomId}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "sightings", filter: `room_id=eq.${roomId}` },
            () => onRealtime?.()
          )
          .subscribe();
        return () => client.removeChannel(ch);
      },
      async uploadMedia(file: File) {
        const ext = file.name.split(".").pop();
        const path = `${roomId}/${uuidv4()}.${ext}`;
        const { error } = await client.storage.from("media").upload(path, file, {
          upsert: false,
          cacheControl: "3600",
        });
        if (error) throw error;
        const { data } = client.storage.from("media").getPublicUrl(path);
        return data.publicUrl as string;
      },
    };
  }, [client, roomId, onRealtime]);
}

/* ===========================
   CSV export
=========================== */
function exportCSV(rows: Sighting[]) {
  const headers = [
    "id",
    "room_id",
    "user_name",
    "title",
    "notes",
    "lat",
    "lng",
    "when_iso",
    "media_url",
    "upvotes",
    "shape",
    "color",
    "car_make",
    "car_model",
  ];
  const body = rows.map(r =>
    headers.map(h =>
      r as any && (r as any)[h] != null ? String((r as any)[h]).replaceAll('"', '""') : ""
    )
  );
  const csv = [headers.join(","), ...body.map(r => `"${r.join('","')}"`)].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ufo-sightings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ===========================
   Simple components
=========================== */
function SightingItem({
  s,
  onVote,
  onDelete,
}: {
  s: Sighting;
  onVote: (id: string, d: number) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{s.title}</CardTitle>
          <div className="flex items-center gap-2">
            {s.shape && <Badge variant="secondary">{s.shape}</Badge>}
            {s.color && <Badge variant="outline">{s.color}</Badge>}
            <Badge variant="secondary">{format(new Date(s.when_iso), "PPp")}</Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <Trash className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem className="text-red-600" onClick={() => onDelete(s.id)}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          By {s.user_name} • ({s.lat.toFixed(3)}, {s.lng.toFixed(3)})
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!!s.notes && <p className="text-sm whitespace-pre-wrap">{s.notes}</p>}
        {s.media_url && (
          <a
            href={s.media_url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-xl overflow-hidden border"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.media_url} alt="media" className="w-full max-h-80 object-cover" />
          </a>
        )}
        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => onVote(s.id, +1)}>
              ▲ Upvote
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onVote(s.id, -1)}>
              ▼ Downvote
            </Button>
          </div>
          <Badge>{nl(s.upvotes, 0)} points</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function SightingForm({
  onSubmit,
  uploadMedia,
  requireAuth,
  isAuthed,
}: {
  onSubmit: (s: Partial<Sighting> | null, errMsg?: string) => void;
  uploadMedia?: (file: File) => Promise<string>;
  requireAuth: boolean;
  isAuthed: boolean;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [shape, setShape] = useState("");
  const [color, setColor] = useState("");
  const [carMake, setCarMake] = useState("");
  const [carModel, setCarModel] = useState("");
  const [reportAnon, setReportAnon] = useState(false);

  const [whenISO, setWhenISO] = useState(localInputNow);
  const [coords, setCoords] = useState<[number, number] | null>(null);
  const [media, setMedia] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(() => storage.get("ufo:user:name", ""));

  useEffect(() => storage.set("ufo:user:name", name), [name]);

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
            <div className="flex items-center justify-between">
              <Label>Your name</Label>
              <label className="text-xs flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={reportAnon}
                  onChange={e => setReportAnon(e.target.checked)}
                />
                Report anonymously
              </label>
            </div>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Roger"
              disabled={reportAnon}
            />
          </div>

          <div>
            <Label>Title</Label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Bright light over park"
            />
          </div>

          <div>
            <Label>When</Label>
            <Input type="datetime-local" value={whenISO} onChange={e => setWhenISO(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Shape</Label>
              <select
                className="border rounded-md h-10 px-2 w-full"
                value={shape}
                onChange={e => setShape(e.target.value)}
              >
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
              <select
                className="border rounded-md h-10 px-2 w-full"
                value={color}
                onChange={e => setColor(e.target.value)}
              >
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

          {/* Vehicle (optional) */}
          <div>
            <Label>Vehicle make (optional)</Label>
            <Input
              value={carMake}
              onChange={e => setCarMake(e.target.value)}
              placeholder="e.g., Toyota"
            />
          </div>
          <div>
            <Label>Vehicle model (optional)</Label>
            <Input
              value={carModel}
              onChange={e => setCarModel(e.target.value)}
              placeholder="e.g., Camry"
            />
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
            <span className="text-xs text-muted-foreground">Click the map to set coordinates</span>
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
              setCarMake("");
              setCarModel("");
              setFile(null);
              setWhenISO(localInputNow());
            }}
          >
            Clear
          </Button>

          <Button
            onClick={async () => {
              if (!title || !whenISO || !coords) {
                return onSubmit(
                  null,
                  "Please provide a title, time, and click the map to set a location."
                );
              }
              let mediaUrl = media || "";
              if (!mediaUrl && file && uploadMedia) {
                try {
                  mediaUrl = await uploadMedia(file);
                } catch (e: any) {
                  return onSubmit(null, "Upload failed: " + (e?.message || String(e)));
                }
              }
              onSubmit({
                id: uuidv4(),
                room_id: "", // filled by parent
                user_name: reportAnon ? "Anonymous" : name || "Anonymous",
                title,
                notes,
                lat: coords[0],
                lng: coords[1],
                when_iso: new Date(whenISO).toISOString(),
                media_url: mediaUrl || null,
                upvotes: 0,
                shape,
                color,
                car_make: carMake || null,
                car_model: carModel || null,
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

/* ===========================
   Main App
=========================== */
export default function App() {
  const { url, key, setUrl, setKey, client, user } = useSupabase();
  const {
    roomId,
    setRoomId,
    roomName,
    setRoomName,
    ownerEmail,
    setOwnerEmail,
    adminCode,
    setAdminCode,
  } = useRoom();

  const [requireAuth, setRequireAuth] = useState<boolean>(() =>
    storage.get<boolean>("ufo:room:reqauth", false)
  );
  useEffect(() => storage.set("ufo:room:reqauth", requireAuth), [requireAuth]);

  const localStore = useLocalSightings(roomId);
  const remoteStore = useRemoteSightings(client, roomId, () => reload());
  const store = remoteStore || localStore;

  const [list, setList] = useState<Sighting[]>([]);
  const [loading, setLoading] = useState(false);
  const [member, setMember] = useState<Member | null>(null);
  const [tab, setTab] = useState("map");

  async function reload() {
    setLoading(true);
    try {
      const rows = await store.list();
      setList(rows);
    } catch (e: any) {
      console.error(e);
      toast.error("Load failed", { description: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }

  // ---- Member lookup (robust) ----
  async function loadMember() {
    if (!client || !user?.email) {
      setMember(null);
      return;
    }
    try {
      const { data, error } = await client
        .from("members")
        .select("*")
        .eq("email", user.email)
        .eq("room_id", roomId)
        .maybeSingle();

      // Ignore "no rows" code; report real errors
      if (error && (error as any).code !== "PGRST116") {
        console.error("Member lookup error:", error);
        toast.error("Member lookup failed", {
          description: (error as any)?.message ?? String(error),
        });
        setMember(null);
        return;
      }
      setMember((data as Member) || null);
    } catch (err: any) {
      console.error("Member lookup threw:", err);
      toast.error("Member lookup failed", { description: err?.message ?? String(err) });
      setMember(null);
    }
  }

  // call once deps are ready
  useEffect(() => {
    if (!client) return;
    loadMember();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, roomId, user?.email]);

  useEffect(() => {
    reload();
    if (remoteStore?.subscribe) {
      const unsub = remoteStore.subscribe();
      return () => unsub?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, client]);

  async function createSighting(base: Partial<Sighting> | null, errMsg?: string) {
    if (!base)
      return toast.error("Missing info", {
        description: errMsg || "Please fill required fields.",
      });
    const s: Sighting = { ...(base as Sighting), room_id: roomId };
    try {
      await store.upsert(s);
      toast.success("Sighting logged", { description: "Shared with your circle." });
      reload();

      // (Optional) notify members by email/SMS if /api/notify is wired
      try {
        await fetch("/api/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: s.title, notes: s.notes || "", room_id: s.room_id }),
        });
      } catch {}
    } catch (e: any) {
      console.error(e);
      toast.error("Save failed", { description: e?.message || String(e) });
    }
  }

  async function vote(id: string, delta: number) {
    try {
      await store.vote(id, delta);
      reload();
    } catch {
      reload();
    }
  }

  async function remove(id: string) {
    // owner or admin code
    if (user?.email && ownerEmail && user.email === ownerEmail) {
      // ok
    } else if (adminCode) {
      const code = window.prompt("Enter admin code to delete");
      if (code !== adminCode)
        return toast.error("Not authorized", { description: "Incorrect admin code." });
    } else if (requireAuth) {
      return toast.error("Not authorized", { description: "Only the owner can delete." });
    }
    try {
      await store.remove(id);
      reload();
    } catch (e: any) {
      toast.error("Delete failed", { description: e?.message || String(e) });
    }
  }

  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const u = new URL(window.location.href);
    u.searchParams.set("room", roomId);
    return u.toString();
  }, [roomId]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* Header */}
      <header className="sticky top-0 z-20 backdrop-blur bg-white/70 border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🛸</span>
            <div>
              <div className="text-xl font-semibold">{roomName}</div>
              <div className="text-xs text-muted-foreground">Room ID: {roomId}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary" size="sm">
                  <Settings className="h-4 w-4 mr-1" /> Settings
                </Button>
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
                        <Button variant="outline" onClick={() => setRoomId(uuidv4().slice(0, 8))}>
                          New
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <Label>Owner email (optional)</Label>
                      <Input
                        value={ownerEmail}
                        onChange={e => setOwnerEmail(e.target.value)}
                        placeholder="owner@you.com"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        If set, that signed-in user bypasses admin code for deletes.
                      </p>
                    </div>
                    <div>
                      <Label>Admin code (optional)</Label>
                      <Input
                        value={adminCode}
                        onChange={e => setAdminCode(e.target.value)}
                        placeholder="e.g., moonbeam-42"
                      />
                    </div>
                  </div>

                  <div className="rounded-xl border p-3 bg-slate-50 space-y-2">
                    <div className="font-medium">Auth (Supabase magic link)</div>
                    <AuthControls client={client} />
                    <div className="flex items-center gap-3 mt-2">
                      <input
                        type="checkbox"
                        id="req"
                        checked={requireAuth}
                        onChange={e => setRequireAuth(e.target.checked)}
                      />
                      <Label htmlFor="req">Require sign-in to post</Label>
                    </div>
                  </div>

                  <div className="rounded-xl border p-3 bg-slate-50">
                    <div className="font-medium mb-2">Optional: Connect Supabase (for realtime + storage)</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <Label>Supabase URL</Label>
                        <Input
                          value={url}
                          onChange={e => setUrl(e.target.value)}
                          placeholder="https://YOUR-PROJECT.supabase.co"
                        />
                      </div>
                      <div>
                        <Label>Anon key</Label>
                        <Input
                          value={key}
                          onChange={e => setKey(e.target.value)}
                          placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Leave blank to use private, device-only storage. Fill both fields to enable cloud sync and multi-user rooms. Storage bucket name expected: <code>media</code>.
                    </p>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            <Button
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(inviteUrl);
                toast.success("Invite copied", {
                  description: "Share this link so friends join your circle.",
                });
              }}
            >
              <Share2 className="h-4 w-4 mr-1" /> Invite
            </Button>
            <Button size="sm" variant="outline" onClick={() => exportCSV(list)}>
              Export CSV
            </Button>
          </div>
        </div>
      </header>

      {/* Main */}
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
                <div className="text-xs text-muted-foreground">
                  Showing {list.length} sightings. {loading ? "Refreshing…" : ""}
                </div>
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
              uploadMedia={remoteStore?.uploadMedia ? (f: File) => remoteStore.uploadMedia(f) : undefined}
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

/* ===========================
   Auth controls
=========================== */
function AuthControls({ client }: { client: SupabaseClient | null }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  const [current, setCurrent] = useState<any>(null);

  useEffect(() => {
    if (!client) return;
    client.auth.getUser().then(({ data }) => setCurrent(data?.user || null));
    const { data } = client.auth.onAuthStateChange((_e, sess) =>
      setCurrent(sess?.user || null)
    );
    return () => data?.subscription?.unsubscribe?.();
  }, [client]);

  if (!client)
    return <div className="text-sm text-muted-foreground">Connect Supabase to enable sign-in.</div>;

  return (
    <div className="flex flex-col gap-2">
      {current ? (
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Signed in</Badge>
          <span className="text-sm">{current.email}</span>
          <Button size="sm" variant="outline" onClick={() => client.auth.signOut()}>
            Sign Out
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <Label>Email</Label>
            <Input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            onClick={async () => {
              setStatus("Sending magic link…");
              const { error } = await client!.auth.signInWithOtp({
                email,
                options: {
                  emailRedirectTo:
                    typeof window !== "undefined" ? window.location.href : undefined,
                },
              });
              setStatus(error ? String(error.message || error) : "Check your email for the link.");
            }}
          >
            Send Link
          </Button>
          {status && <div className="text-xs text-muted-foreground">{status}</div>}
        </div>
      )}
    </div>
  );
}
