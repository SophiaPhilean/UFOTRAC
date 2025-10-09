"use client";

import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { v4 as uuidv4 } from "uuid";
import { Toaster, toast } from "sonner";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// UI (shadcn)
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

// ---------------- Map (client-only) ----------------
const SightingsMap = dynamic(() => import("./Map"), { ssr: false }) as React.ComponentType<{
  list: Array<{ id: string; lat: number; lng: number; title?: string; when_iso?: string; user_name?: string; shape?: string; color?: string; car_make?: string; car_model?: string; car_color?: string }>;
  onPick?: (lat: number, lng: number) => void;
}>;

// ---------------- Helpers / Storage ----------------
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

function nowAsLocalDatetimeInput(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return `${y}-${m}-${d}T${h}:${mi}`;
}

// ---------------- Types ----------------
export type Sighting = {
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
  address_text?: string | null;
  // NEW vehicle fields
  car_make?: string | null;
  car_model?: string | null;
  car_color?: string | null;
};

// ---------------- Env Defaults ----------------
const DEFAULTS = {
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  DEFAULT_ROOM_ID: process.env.NEXT_PUBLIC_DEFAULT_ROOM_ID || "",
};

// ---------------- Local store (fallback) ----------------
function useLocalSightings(roomId: string) {
  const key = `ufo:sightings:${roomId}`;
  const getAll = (): Sighting[] => storage.get<Sighting[]>(key, []);
  const setAll = (list: Sighting[]) => storage.set(key, list);

  return {
    async list(): Promise<Sighting[]> {
      return getAll();
    },
    async upsert(s: Sighting) {
      const all = getAll();
      const i = all.findIndex((x) => x.id === s.id);
      if (i >= 0) all[i] = s;
      else all.unshift(s);
      setAll(all);
      return s;
    },
    async remove(id: string) {
      const all = getAll().filter((x) => x.id !== id);
      setAll(all);
    },
    async vote(id: string, delta: number) {
      const all = getAll();
      const i = all.findIndex((x) => x.id === id);
      if (i >= 0) {
        all[i].upvotes = Math.max(0, (all[i].upvotes || 0) + delta);
        setAll(all);
        return all[i];
      }
    },
    async uploadMedia(_file: File, _room: string) {
      throw new Error("Media uploads require Supabase connection.");
    },
  };
}

// ---------------- Supabase store (cloud) ----------------
function useSupabase() {
  const [url, setUrl] = useState(
    () => DEFAULTS.SUPABASE_URL || storage.get("ufo:supa:url", "")
  );
  const [key, setKey] = useState(
    () => DEFAULTS.SUPABASE_ANON_KEY || storage.get("ufo:supa:key", "")
  );
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const effectiveUrl = DEFAULTS.SUPABASE_URL || url;
    const effectiveKey = DEFAULTS.SUPABASE_ANON_KEY || key;

    if (effectiveUrl && effectiveKey) {
      const c = createClient(effectiveUrl, effectiveKey);
      setClient(c);
      c.auth.getUser().then(({ data }) => setUser(data?.user || null));
      const { data } = c.auth.onAuthStateChange((_e, sess) =>
        setUser(sess?.user || null)
      );
      return () => data?.subscription?.unsubscribe?.();
    } else {
      setClient(null);
      setUser(null);
    }
  }, [url, key]);

  useEffect(() => {
    if (!DEFAULTS.SUPABASE_URL) storage.set("ufo:supa:url", url);
  }, [url]);
  useEffect(() => {
    if (!DEFAULTS.SUPABASE_ANON_KEY) storage.set("ufo:supa:key", key);
  }, [key]);

  return {
    url,
    key,
    setUrl,
    setKey,
    client,
    user,
    usingEnv: !!(DEFAULTS.SUPABASE_URL && DEFAULTS.SUPABASE_ANON_KEY),
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
        return (data as Sighting[]) || [];
      },
      async upsert(s: Sighting) {
        const { data, error } = await client
          .from("sightings")
          .upsert(s)
          .select()
          .single();
        if (error) throw error;
        return data as Sighting;
      },
      async remove(id: string) {
        const { error } = await client.from("sightings").delete().eq("id", id);
        if (error) throw error;
      },
      async vote(id: string, delta: number) {
        const { error } = await client.rpc("vote_sighting", {
          p_id: id,
          p_delta: delta,
        });
        if (error) throw error;
        return true;
      },
      subscribe() {
        const ch = client
          .channel(`sightings-${roomId}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "sightings",
              filter: `room_id=eq.${roomId}`,
            },
            () => onRealtime?.()
          )
          .subscribe();
        return () => client.removeChannel(ch);
      },
      async uploadMedia(file: File, room: string) {
        const ext = (file.name.split(".").pop() || "bin").toLowerCase();
        const path = `${room}/${uuidv4()}.${ext}`;
        const { error } = await client
          .storage
          .from("media")
          .upload(path, file, { upsert: false, cacheControl: "3600" });
        if (error) throw error;
        const { data } = client.storage.from("media").getPublicUrl(path);
        return data.publicUrl;
      },
    };
  }, [client, roomId, onRealtime]);
}

// ---------------- Room ----------------
function useRoom() {
  const initial = DEFAULTS.DEFAULT_ROOM_ID || storage.get("ufo:room:id", "");
  const [roomId, setRoomId] = useState(() => initial || uuidv4().slice(0, 8));
  const [roomName, setRoomName] = useState(() =>
    storage.get("ufo:room:name", "My UFO Circle")
  );
  const [ownerEmail, setOwnerEmail] = useState(() =>
    storage.get("ufo:room:owner", "")
  );
  const [adminCode, setAdminCode] = useState(() =>
    storage.get("ufo:room:code", "")
  );
  useEffect(() => storage.set("ufo:room:id", roomId), [roomId]);
  useEffect(() => storage.set("ufo:room:name", roomName), [roomName]);
  useEffect(() => storage.set("ufo:room:owner", ownerEmail), [ownerEmail]);
  useEffect(() => storage.set("ufo:room:code", adminCode), [adminCode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const r = params.get("room");
    if (r) setRoomId(r);
    else if (DEFAULTS.DEFAULT_ROOM_ID) setRoomId(DEFAULTS.DEFAULT_ROOM_ID);
  }, []);

  const roomLocked = !!DEFAULTS.DEFAULT_ROOM_ID;
  return {
    roomId,
    setRoomId,
    roomName,
    setRoomName,
    ownerEmail,
    setOwnerEmail,
    adminCode,
    setAdminCode,
    roomLocked,
  };
}

// ---------------- CSV Export ----------------
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
    "address_text",
    "car_make",
    "car_model",
    "car_color",
  ];
  const body = rows.map((r) =>
    headers.map((h) =>
      (r as any)[h] !== undefined && (r as any)[h] !== null
        ? String((r as any)[h]).replaceAll('"', '""')
        : ""
    )
  );
  const csv =
    [headers.join(","), ...body.map((r) => '"' + r.join('","') + '"')].join(
      "\n"
    );
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ufo-sightings-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------- Rate-limit ----------------
const submitTimes: number[] = [];
function canSubmitNow() {
  const now = Date.now();
  while (submitTimes.length && now - submitTimes[0] > 5 * 60 * 1000)
    submitTimes.shift();
  return submitTimes.length < 3;
}
function recordSubmit() {
  submitTimes.push(Date.now());
}
const BANNED = ["buy now", "free money", "crypto airdrop"];

// ---------------- Geocode ----------------
async function geocodeAddress(q: string): Promise<[number, number] | null> {
  if (!q.trim()) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
    q
  )}`;
  const res = await fetch(url, {
    headers: { "Accept-Language": "en" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string }>;
  if (!data?.length) return null;
  return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
}

// ---------------- Sighting Form ----------------
function SightingForm({
  onSubmit,
  uploadMedia,
  requireAuth,
  isAuthed,
}: {
  onSubmit: (s: Partial<Sighting> | null, errMsg?: string) => void;
  uploadMedia: ((file: File, room: string) => Promise<string>) | null;
  requireAuth: boolean;
  isAuthed: boolean;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [shape, setShape] = useState("");
  const [color, setColor] = useState("");
  const [whenISO, setWhenISO] = useState(nowAsLocalDatetimeInput());
  const [coords, setCoords] = useState<[number, number] | null>(null);
  const [address, setAddress] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(() => storage.get("ufo:user:name", ""));
  // NEW vehicle
  const [carMake, setCarMake] = useState("");
  const [carModel, setCarModel] = useState("");
  const [carColor, setCarColor] = useState("");

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
            <Label>Your name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Roger"
            />
          </div>
          <div>
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Bright light over park"
            />
          </div>

          <div>
            <Label>When</Label>
            <Input
              type="datetime-local"
              value={whenISO}
              onChange={(e) => setWhenISO(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Times are saved and shown in your local timezone.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Shape</Label>
              <select
                className="border rounded-md h-10 px-2 w-full"
                value={shape}
                onChange={(e) => setShape(e.target.value)}
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
                onChange={(e) => setColor(e.target.value)}
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

          <div className="md:col-span-2">
            <Label>Notes</Label>
            <Textarea
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Describe movement, color, duration, witnesses…"
            />
          </div>

          {/* NEW Vehicle section (optional) */}
          <div className="md:col-span-2 rounded-xl border p-3">
            <div className="font-medium mb-2">Vehicle (optional)</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label>Make</Label>
                <Input
                  value={carMake}
                  onChange={(e) => setCarMake(e.target.value)}
                  placeholder="e.g., Toyota"
                />
              </div>
              <div>
                <Label>Model</Label>
                <Input
                  value={carModel}
                  onChange={(e) => setCarModel(e.target.value)}
                  placeholder="e.g., Camry"
                />
              </div>
              <div>
                <Label>Color</Label>
                <Input
                  value={carColor}
                  onChange={(e) => setCarColor(e.target.value)}
                  placeholder="e.g., Blue"
                />
              </div>
            </div>
          </div>

          <div className="md:col-span-2 grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div>
              <Label>Photo / video URL (optional)</Label>
              <Input
                value={mediaUrl}
                onChange={(e) => setMediaUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>

            <div>
              <Label>Upload media (optional)</Label>
              <div className="flex items-center gap-3">
                <input
                  type="file"
                  accept="image/*,video/*"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  className="block w-full text-sm border rounded-md p-2 bg-white"
                />
                {file && (
                  <Badge variant="secondary" className="whitespace-nowrap">
                    {file.name}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Uploads require Supabase connection.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Location</Label>
            <span className="text-xs text-muted-foreground">
              Click the map or enter an address/place below.
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="lg:col-span-2">
              <SightingsMap
                list={
                  coords ? [{ id: "temp", lat: coords[0], lng: coords[1] }] : []
                }
                onPick={(lat, lng) => setCoords([lat, lng])}
              />
              {coords && (
                <div className="text-sm text-muted-foreground mt-1">
                  Lat {coords[0].toFixed(5)}, Lng {coords[1].toFixed(5)}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Address or place</Label>
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="e.g., Post Office, Glen Cove, NY"
              />
              <Button
                variant="outline"
                onClick={async () => {
                  if (!address.trim()) return;
                  const pos = await geocodeAddress(address);
                  if (pos) setCoords(pos);
                  else
                    toast.error(
                      "Could not find that place. Try a more specific address."
                    );
                }}
              >
                Find on Map
              </Button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setTitle("");
              setNotes("");
              setMediaUrl("");
              setFile(null);
              setCoords(null);
              setAddress("");
              setShape("");
              setColor("");
              setCarMake("");
              setCarModel("");
              setCarColor("");
              setWhenISO(nowAsLocalDatetimeInput()); // reset to local now
            }}
          >
            Clear
          </Button>

          <Button
            onClick={async () => {
              if (!title || !whenISO || (!coords && !address.trim())) {
                return onSubmit?.(
                  null,
                  "Please provide a title, time, and either click the map or enter an address."
                );
              }
              if (notes && BANNED.some((w) => notes.toLowerCase().includes(w))) {
                return onSubmit?.(null, "Notes contain blocked terms.");
              }
              if (!canSubmitNow()) {
                return onSubmit?.(null, "Rate limit: max 3 reports per 5 minutes.");
              }

              let finalCoords = coords;
              if (!finalCoords && address.trim()) {
                finalCoords = await geocodeAddress(address);
                if (!finalCoords) {
                  return onSubmit?.(
                    null,
                    "Address could not be located. Please try a more exact place."
                  );
                }
              }

              let finalMedia = mediaUrl || "";
              if (!finalMedia && file && uploadMedia) {
                try {
                  finalMedia = await uploadMedia(file, "room");
                } catch (e: any) {
                  return onSubmit?.(
                    null,
                    "Upload failed: " + (e?.message || e)
                  );
                }
              }

              onSubmit?.({
                id: uuidv4(),
                room_id: "",
                user_name: name || "Anonymous",
                title,
                notes,
                lat: finalCoords![0],
                lng: finalCoords![1],
                when_iso: new Date(whenISO).toISOString(), // store as UTC
                media_url: finalMedia || null,
                upvotes: 0,
                shape,
                color,
                address_text: address || null,
                car_make: carMake || null,
                car_model: carModel || null,
                car_color: carColor || null,
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

// ---------------- Item ----------------
function SightingItem({
  s,
  onVote,
  onDelete,
}: {
  s: Sighting;
  onVote: (id: string, delta: number) => void;
  onDelete: (id: string) => void;
}) {
  const whenLocal = useMemo(() => {
    try {
      return new Date(s.when_iso).toLocaleString();
    } catch {
      return s.when_iso;
    }
  }, [s.when_iso]);

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{s.title}</CardTitle>
          <div className="flex items-center gap-2">
            {s.shape && <Badge variant="secondary">{s.shape}</Badge>}
            {s.color && <Badge variant="outline">{s.color}</Badge>}
            <Badge variant="secondary">{whenLocal}</Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Delete">
                  <Trash className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  onClick={() => onDelete?.(s.id)}
                  className="text-red-600"
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          Reported by {s.user_name} • ({s.lat.toFixed(3)}, {s.lng.toFixed(3)})
          {s.address_text ? ` • ${s.address_text}` : ""}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {s.notes && (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{s.notes}</p>
        )}

        {/* NEW: Vehicle badge row */}
        {(s.car_make || s.car_model || s.car_color) && (
          <div className="flex flex-wrap gap-2">
            {s.car_make && <Badge variant="secondary">Make: {s.car_make}</Badge>}
            {s.car_model && <Badge variant="secondary">Model: {s.car_model}</Badge>}
            {s.car_color && <Badge variant="secondary">Color: {s.car_color}</Badge>}
          </div>
        )}

        {s.media_url && (
          <a
            href={s.media_url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-xl overflow-hidden border"
          >
            <img
              src={s.media_url}
              alt="evidence"
              className="w-full max-h-80 object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </a>
        )}
        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => onVote?.(s.id, +1)}>
              ▲ Upvote
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onVote?.(s.id, -1)}>
              ▼ Downvote
            </Button>
          </div>
          <Badge>{s.upvotes ?? 0} points</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------- Auth ----------------
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
    return (
      <div className="text-sm text-muted-foreground">
        Connect Supabase to enable sign-in.
      </div>
    );

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
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            onClick={async () => {
              setStatus("Sending magic link…");
              const { error } = await client.auth.signInWithOtp({
                email,
                options: { emailRedirectTo: window.location.href },
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

// ---------------- Main App ----------------
export default function App() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { url, key, setUrl, setKey, client, user, usingEnv } = useSupabase();
  const {
    roomId,
    setRoomId,
    roomName,
    setRoomName,
    ownerEmail,
    setOwnerEmail,
    adminCode,
    setAdminCode,
    roomLocked,
  } = useRoom();

  const [requireAuth, setRequireAuth] = useState<boolean>(() =>
    storage.get("ufo:room:reqauth", false)
  );
  useEffect(() => storage.set("ufo:room:reqauth", requireAuth), [requireAuth]);

  const localStore = useLocalSightings(roomId);
  const remoteStore = useRemoteSightings(client, roomId, () => reload());
  const store: any = remoteStore || localStore;

  const [list, setList] = useState<Sighting[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("map");
  const [inviteUrl, setInviteUrl] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    u.searchParams.set("room", roomId);
    setInviteUrl(u.toString());
  }, [roomId]);

  async function reload() {
    setLoading(true);
    try {
      const rows = (await store.list()) as Sighting[];
      setList(rows);
    } catch (e: any) {
      console.error(e);
      toast.error("Load failed", { description: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!roomId) return;
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
    const s = { ...(base as Sighting), room_id: roomId };
    try {
      await store.upsert(s);
      recordSubmit();

      fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: s.title, notes: s.notes, room_id: roomId }),
      }).catch(() => {});

      toast.success("Sighting logged", { description: "Shared with your circle." });
      reload();
    } catch (e: any) {
      console.error(e);
      toast.error("Save failed", { description: String(e?.message || e) });
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
      toast.error("Delete failed", { description: String(e?.message || e) });
    }
  }

  if (!mounted) return null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
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
                      <Input value={roomName} onChange={(e) => setRoomName(e.target.value)} />
                    </div>
                    <div>
                      <Label>Room ID</Label>
                      <div className="flex gap-2">
                        <Input
                          value={roomId}
                          onChange={(e) => setRoomId(e.target.value.trim())}
                          disabled={roomLocked}
                        />
                        <Button
                          variant="outline"
                          onClick={() => setRoomId(uuidv4().slice(0, 8))}
                          disabled={roomLocked}
                        >
                          New
                        </Button>
                      </div>
                      {roomLocked && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Room ID is pinned by the deployment (read-only).
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <Label>Owner email (optional)</Label>
                      <Input
                        value={ownerEmail}
                        onChange={(e) => setOwnerEmail(e.target.value)}
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
                        onChange={(e) => setAdminCode(e.target.value)}
                        placeholder="e.g., moonbeam-42"
                      />
                    </div>
                  </div>

                  {!usingEnv ? (
                    <div className="rounded-xl border p-3 bg-slate-50">
                      <div className="font-medium mb-2">
                        Optional: Connect Supabase (for realtime + storage)
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <Label>Supabase URL</Label>
                          <Input
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://YOUR-PROJECT.supabase.co"
                          />
                        </div>
                        <div>
                          <Label>Anon key</Label>
                          <Input
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                            placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        Leave blank to use private, device-only storage. Fill both fields to
                        enable cloud sync and multi-user rooms. Storage bucket name expected:{" "}
                        <code>media</code>.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-xl border p-3 bg-slate-50">
                      <div className="font-medium mb-1">Supabase</div>
                      <p className="text-xs text-muted-foreground">
                        This deployment is pre-connected to Supabase (read-only settings).
                      </p>
                    </div>
                  )}
                </div>
              </DialogContent>
            </Dialog>

            <Button
              size="sm"
              onClick={async () => {
                if (!inviteUrl) return;
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
              {list.map((s) => (
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
              uploadMedia={remoteStore?.uploadMedia ? (file) => remoteStore.uploadMedia(file, roomId) : null}
              requireAuth={requireAuth}
              isAuthed={!!user}
            />
          </TabsContent>
        </Tabs>

        <footer className="text-center text-xs text-muted-foreground pt-6">
          Built with ❤️ for curious sky-watchers & neighborhood watch. Your data stays on your
          device unless you connect Supabase.
        </footer>
      </main>

      <Toaster richColors position="top-right" />
    </div>
  );
}
