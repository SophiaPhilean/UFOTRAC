"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import { format } from "date-fns";
import { motion } from "framer-motion";

// shadcn/ui
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

// Dynamically import the map (prevents SSR “window is not defined”)
const SightingsMap = dynamic(() => import("./Map"), { ssr: false });

// ---------------- Helpers ----------------
const storage = {
  get<T>(key: string, fallback: T): T {
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
function classNames(...s: (string | false | null | undefined)[]) {
  return s.filter(Boolean).join(" ");
}

// ---------------- Types ----------------
/** Sighting shape used both locally and with Supabase */
export type Category = "UFO" | "Drone" | "Vehicle";

/** @typedef {{
  id: string,
  created_at?: string | null,
  room_id: string,
  user_name: string,
  title: string,
  notes: string,
  lat: number,
  lng: number,
  when_iso: string,
  media_url?: string | null,
  upvotes: number,
  // legacy
  shape?: string | null,
  color?: string | null,
  // new
  category?: Category,
  vehicle_make?: string | null,
  vehicle_model?: string | null,
  vehicle_color?: string | null,
  address?: string | null
}} Sighting */
export type Sighting = {
  id: string;
  created_at?: string | null;
  room_id: string;
  user_name: string;
  title: string;
  notes: string;
  lat: number;
  lng: number;
  when_iso: string;
  media_url?: string | null;
  upvotes: number;
  shape?: string | null;
  color?: string | null;
  category?: Category;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  vehicle_color?: string | null;
  address?: string | null;
};

// ---------------- Supabase wrapper (optional) ----------------
function useSupabase() {
  const [url, setUrl] = useState(() => storage.get("ufo:supa:url", ""));
  const [key, setKey] = useState(() => storage.get("ufo:supa:key", ""));
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [user, setUser] = useState<any>(null);

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

  useEffect(() => storage.set("ufo:supa:url", url), [url]);
  useEffect(() => storage.set("ufo:supa:key", key), [key]);

  return { url, key, setUrl, setKey, client, user };
}

// ---------------- Rooms ----------------
function useRoom() {
  // Start empty to avoid SSR/client mismatch
  const [roomId, setRoomId] = useState<string>("");
  const [roomName, setRoomName] = useState<string>("");
  const [ownerEmail, setOwnerEmail] = useState<string>("");
  const [adminCode, setAdminCode] = useState<string>("");

  // Hydrate from localStorage only on client
  useEffect(() => {
    const initialRoomId = storage.get("ufo:room:id", "") || uuidv4().slice(0, 8);
    const initialRoomName = storage.get("ufo:room:name", "My UFO Circle");
    const initialOwner = storage.get("ufo:room:owner", "");
    const initialCode = storage.get("ufo:room:code", "");
    setRoomId(initialRoomId);
    setRoomName(initialRoomName);
    setOwnerEmail(initialOwner);
    setAdminCode(initialCode);
  }, []);

  useEffect(() => { if (roomId) storage.set("ufo:room:id", roomId); }, [roomId]);
  useEffect(() => { if (roomName) storage.set("ufo:room:name", roomName); }, [roomName]);
  useEffect(() => { storage.set("ufo:room:owner", ownerEmail); }, [ownerEmail]);
  useEffect(() => { storage.set("ufo:room:code", adminCode); }, [adminCode]);

  return { roomId, setRoomId, roomName, setRoomName, ownerEmail, setOwnerEmail, adminCode, setAdminCode };
}


// ---------------- Local store (fallback) ----------------
function useLocalSightings(roomId: string) {
  const key = `ufo:sightings:${roomId}`;
  const getAll = () => storage.get<Sighting[]>(key, []);
  const setAll = (list: Sighting[]) => storage.set(key, list);
  return {
    async list() {
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
      setAll(getAll().filter((x) => x.id !== id));
    },
    async vote(id: string, delta: number) {
      const all = getAll();
      const i = all.findIndex((x) => x.id === id);
      if (i >= 0) {
        all[i].upvotes = (all[i].upvotes || 0) + delta;
        setAll(all);
        return all[i];
      }
    },
  };
}

// ---------------- Remote store (Supabase) ----------------
function useRemoteSightings(
  client: SupabaseClient | null,
  roomId: string,
  onRealtime?: (payload: any) => void
) {
  return useMemo(() => {
    if (!client) return null;
    return {
      client,
      async list(): Promise<Sighting[]> {
        const { data, error } = await client
          .from("sightings")
          .select("*")
          .eq("room_id", roomId)
          .order("when_iso", { ascending: false });
        if (error) throw error;
        return (data as Sighting[]) || [];
      },
      async upsert(s: Sighting): Promise<Sighting> {
        const { data, error } = await client.from("sightings").upsert(s).select().single();
        if (error) throw error;
        return data as Sighting;
      },
      async remove(id: string) {
        const { error } = await client.from("sightings").delete().eq("id", id);
        if (error) throw error;
      },
      async vote(id: string, delta: number) {
        const { data, error } = await client.rpc("vote_sighting", { p_id: id, p_delta: delta });
        if (error) throw error;
        return data;
      },
      subscribe() {
        const ch = client
          .channel(`sightings-${roomId}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "sightings", filter: `room_id=eq.${roomId}` },
            (payload) => onRealtime?.(payload)
          )
          .subscribe();
        return () => client.removeChannel(ch);
      },
      async uploadMedia(file: File, room: string) {
        const ext = file.name.split(".").pop();
        const path = `${room}/${uuidv4()}.${ext}`;
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

// ---------------- Simple spam/rate limit ----------------
const submitTimes: number[] = [];
function canSubmitNow() {
  const now = Date.now();
  while (submitTimes.length && now - submitTimes[0] > 5 * 60 * 1000) submitTimes.shift();
  return submitTimes.length < 3;
}
function recordSubmit() {
  submitTimes.push(Date.now());
}
const BANNED = ["buy now", "free money", "crypto airdrop"];

// ---------------- Geocoding (address → coords) ----------------
async function geocodePlace(q: string): Promise<[number, number] | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`,
      { headers: { "Accept-Language": "en" } }
    );
    const data = await res.json();
    if (Array.isArray(data) && data[0]) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lat, lon];
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------- Sighting Form ----------------
type SightingFormProps = {
  onSubmit: (s: Partial<Sighting> | null, errMsg?: string) => void;
  uploadMedia?: ((file: File) => Promise<string>) | null;
  requireAuth: boolean;
  isAuthed: boolean;
};

function SightingForm({ onSubmit, uploadMedia, requireAuth, isAuthed }: SightingFormProps) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [shape, setShape] = useState("");
  const [color, setColor] = useState("");
  const [category, setCategory] = useState<Category>("UFO");
  const [vehicleMake, setVehicleMake] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [vehicleColor, setVehicleColor] = useState("");
  const [whenISO, setWhenISO] = useState("");
useEffect(() => {
  setWhenISO(new Date().toISOString().slice(0, 16));
}, []);

  const [coords, setCoords] = useState<[number, number] | null>(null);
  const [address, setAddress] = useState("");
  const [media, setMedia] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(() => storage.get("ufo:user:name", ""));
  useEffect(() => storage.set("ufo:user:name", name), [name]);

  // If address is entered and no coords set, try geocoding on blur
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  async function handleGeocodeIfNeeded() {
    if (address.trim() && !coords) {
      const out = await geocodePlace(address.trim());
      if (out) setCoords(out);
      else toast.error("Couldn’t find that place. Try a more specific address.");
    }
  }

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
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Roger" />
          </div>
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bright light over park" />
          </div>

          <div>
            <Label>When</Label>
            <Input type="datetime-local" value={whenISO} onChange={(e) => setWhenISO(e.target.value)} />
          </div>

          {/* Category + Shape/Color (or Vehicle fields) */}
          <div className="md:col-span-1">
            <Label>Category</Label>
            <select
              className="border rounded-md h-10 px-2 w-full"
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
            >
              <option>UFO</option>
              <option>Drone</option>
              <option>Vehicle</option>
            </select>
          </div>

          {category !== "Vehicle" && (
            <div className="grid grid-cols-2 gap-2 md:col-span-1">
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
          )}

          {category === "Vehicle" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:col-span-1">
              <div>
                <Label>Make</Label>
                <Input value={vehicleMake} onChange={(e) => setVehicleMake(e.target.value)} placeholder="e.g., Toyota" />
              </div>
              <div>
                <Label>Model</Label>
                <Input value={vehicleModel} onChange={(e) => setVehicleModel(e.target.value)} placeholder="e.g., Camry" />
              </div>
              <div>
                <Label>Color</Label>
                <Input value={vehicleColor} onChange={(e) => setVehicleColor(e.target.value)} placeholder="e.g., Blue" />
              </div>
            </div>
          )}

          <div className="md:col-span-2">
            <Label>Notes</Label>
            <Textarea
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Describe movement, color, duration, witnesses…"
            />
          </div>

          <div>
            <Label>Place or Address (optional)</Label>
            <Input
              ref={addressInputRef}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onBlur={handleGeocodeIfNeeded}
              placeholder="Post Office, Glen Cove, NY"
            />
          </div>

          <div>
            <Label>Photo / video URL (optional)</Label>
            <Input value={media} onChange={(e) => setMedia(e.target.value)} placeholder="https://…" />
          </div>
          <div>
            <Label>Or upload media (Supabase)</Label>
            <input
              type="file"
              accept="image/*,video/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Location</Label>
            <span className="text-xs text-muted-foreground">Click the map to set coordinates</span>
          </div>
          <div className="rounded-2xl overflow-hidden">
            <SightingsMap
              // Map accepts a list; here we only use the selection center, so pass just the current point
              list={coords ? [{ id: "preview", lat: coords[0], lng: coords[1] } as any] : []}
              // clicking on the map should update coords
              onPick={(lat: number, lng: number) => setCoords([lat, lng])}
            />
          </div>
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
              setCategory("UFO");
              setVehicleMake("");
              setVehicleModel("");
              setVehicleColor("");
              setWhenISO(new Date().toISOString().slice(0, 16));
            }}
          >
            Clear
          </Button>

          <Button
            onClick={async () => {
              if (!title || !whenISO || (!coords && !address.trim()))
                return onSubmit?.(null, "Please provide a title, time, and either click the map or enter an address.");
              if (notes && BANNED.some((w) => notes.toLowerCase().includes(w)))
                return onSubmit?.(null, "Notes contain blocked terms.");
              if (!canSubmitNow()) return onSubmit?.(null, "Rate limit: max 3 reports per 5 minutes.");

              // If user entered address but no coords yet, try geocoding once more before save
              if (!coords && address.trim()) {
                const out = await geocodePlace(address.trim());
                if (out) setCoords(out);
                if (!out) return onSubmit?.(null, "Could not locate that address. Please pin on map.");
              }
              const finalCoords = coords!;
              let mediaUrl = media || "";
              if (!mediaUrl && file && uploadMedia) {
                try {
                  mediaUrl = await uploadMedia(file);
                } catch (e: any) {
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

                category,
                shape: category !== "Vehicle" ? (shape || null) : null,
                color: category !== "Vehicle" ? (color || null) : null,
                vehicle_make: category === "Vehicle" ? (vehicleMake || null) : null,
                vehicle_model: category === "Vehicle" ? (vehicleModel || null) : null,
                vehicle_color: category === "Vehicle" ? (vehicleColor || null) : null,

                address: address ? address : null,
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
function SightingItem({
  s,
  onVote,
  onDelete,
}: {
  s: Sighting;
  onVote: (id: string, delta: number) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="hover:shadow-xl transition-shadow">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{s.title}</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{s.category || "UFO"}</Badge>
              {s.category !== "Vehicle" && s.shape && <Badge variant="secondary">{s.shape}</Badge>}
              {(s.color || s.vehicle_color) && <Badge variant="outline">{s.color || s.vehicle_color}</Badge>}
              {s.category === "Vehicle" && (s.vehicle_make || s.vehicle_model) && (
                <Badge variant="secondary">
                  {(s.vehicle_make || "")} {(s.vehicle_model || "")}
                </Badge>
              )}
              <Badge variant="secondary">{format(new Date(s.when_iso), "PPp")}</Badge>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <Trash className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => onDelete?.(s.id)} className="text-red-600">
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            Reported by {s.user_name} • ({s.lat.toFixed(3)}, {s.lng.toFixed(3)})
            {s.address ? ` • ${s.address}` : ""}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{s.notes}</p>
          {s.media_url && (
            <a
              href={s.media_url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-xl overflow-hidden border"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.media_url} alt="evidence" className="w-full max-h-80 object-cover" />
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
    </motion.div>
  );
}

// ---------------- CSV export ----------------
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
    "category",
    "vehicle_make",
    "vehicle_model",
    "vehicle_color",
    "address",
  ];
  const body = rows.map((r) =>
    headers.map((h) => ((r as any)[h] !== undefined && (r as any)[h] !== null ? String((r as any)[h]).replaceAll('"', '""') : ""))
  );
  const csv = [headers.join(","), ...body.map((r) => '"' + r.join('","') + '"')].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ufo-sightings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------- Main App ----------------
export default function App() {
  const { url, key, setUrl, setKey, client, user } = useSupabase();
  const { roomId, setRoomId, roomName, setRoomName, ownerEmail, setOwnerEmail, adminCode, setAdminCode } = useRoom();
  const [requireAuth, setRequireAuth] = useState<boolean>(() => storage.get("ufo:room:reqauth", false));
  useEffect(() => storage.set("ufo:room:reqauth", requireAuth), [requireAuth]);

  const localStore = useLocalSightings(roomId);
  const remoteStore = useRemoteSightings(client, roomId, () => reload());
  const store = (remoteStore as any) || localStore;

  const [list, setList] = useState<Sighting[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("map");
  const [inviteUrl, setInviteUrl] = useState("");

  useEffect(() => {
    // hydrate invite URL on the client
    const u = new URL(window.location.href);
    u.searchParams.set("room", roomId);
    setInviteUrl(u.toString());
  }, [roomId]);

  useEffect(() => {
    // read ?room= from URL (join links)
    const params = new URLSearchParams(window.location.search);
    const r = params.get("room");
    if (r) setRoomId(r);
  }, [setRoomId]);

  async function reload() {
    setLoading(true);
    try {
      const rows = await store.list();
      setList(rows as Sighting[]);
    } catch (e: any) {
      console.error(e);
      toast.error("Load failed", { description: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    if (remoteStore?.subscribe) {
      const unsub = remoteStore.subscribe();
      return () => unsub?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, client]);

  async function createSighting(base: Partial<Sighting> | null, errMsg?: string) {
    if (!base) return toast.error("Missing info", { description: errMsg || "Please fill required fields." });
    const s = { ...(base as Sighting), room_id: roomId };
    try {
      await store.upsert(s);
      recordSubmit();

      // Fire-and-forget: email notifications to members of this room
      fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: s.title,
          notes: s.notes,
          room_id: roomId,
        }),
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
    // Basic admin protection
    if (user?.email && ownerEmail && user.email === ownerEmail) {
      // owner OK
    } else if (adminCode) {
      const code = window.prompt("Enter admin code to delete");
      if (code !== adminCode) return toast.error("Not authorized", { description: "Incorrect admin code." });
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <header className="sticky top-0 z-20 backdrop-blur bg-white/70 border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🛸</span>
            <div>
              <div className="text-xl font-semibold">{roomName}</div>
             <div className="text-xs text-muted-foreground">Room ID: {roomId || "…"}</div>
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
                        <Input value={roomId} onChange={(e) => setRoomId(e.target.value.trim())} />
                        <Button
                          variant="outline"
                          onClick={() => {
                            const r = uuidv4().slice(0, 8);
                            setRoomId(r);
                          }}
                        >
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
                        onChange={(e) => setOwnerEmail(e.target.value)}
                        placeholder="owner@you.com"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        If set, that signed-in user bypasses admin code for deletes.
                      </p>
                    </div>
                    <div>
                      <Label>Admin code (optional)</Label>
                      <Input value={adminCode} onChange={(e) => setAdminCode(e.target.value)} placeholder="e.g., moonbeam-42" />
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
                        onChange={(e) => setRequireAuth(e.target.checked)}
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
                      Leave blank to use private, device-only storage. Fill both fields to enable cloud sync and multi-user rooms. Storage
                      bucket name expected: <code>media</code>.
                    </p>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            <Button
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(inviteUrl);
                toast.success("Invite copied", { description: "Share this link so friends join your circle." });
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
          Built with ❤️ for curious sky-watchers & neighborhood watch. Your data stays on your device unless you connect Supabase.
        </footer>
      </main>

      <Toaster richColors position="top-right" />
    </div>
  );
}

// ---------------- Auth controls ----------------
function AuthControls({ client }: { client: SupabaseClient | null }) {
  const [email, setEmail] = useState("");
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
          <Button size="sm" variant="outline" onClick={() => client.auth.signOut()}>
            Sign Out
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <Label>Email</Label>
            <Input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Button
            size="sm"
            onClick={async () => {
              setStatus("Sending magic link…");
              const { error } = await client!.auth.signInWithOtp({
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

/* --------------------- SUPABASE SQL (reference) ---------------------
-- Make sure your DB has these extra columns (run once):
alter table public.sightings
  add column if not exists category text check (category in ('UFO','Drone','Vehicle')) default 'UFO',
  add column if not exists vehicle_make text,
  add column if not exists vehicle_model text,
  add column if not exists vehicle_color text,
  add column if not exists address text;

-- Realtime, function, and storage as you had them earlier.
*/
