"use client";

import React, { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* ===========================
   Types shared with page.tsx
=========================== */
type BasicSighting = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  when_iso: string;
  user_name: string;
  shape?: string | null;
  color?: string | null;
};

/* ===========================
   Click handler for map
=========================== */
function Clicker({ onClick }: { onClick: (latlng: { lat: number; lng: number }) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng);
    },
  });
  return null;
}

/* ===========================
   LocationPicker (click to set)
=========================== */
export function LocationPicker({
  value,
  onChange,
}: {
  value: [number, number] | null;
  onChange: (coords: [number, number]) => void;
}) {
  return (
    <div className="h-64 rounded-2xl overflow-hidden">
      <MapContainer
        center={(value as any) || [40.7128, -74.006]}
        zoom={value ? 11 : 3}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {value && (
          <Marker position={value as any}>
            <Popup>Selected</Popup>
          </Marker>
        )}
        <Clicker onClick={ll => onChange([ll.lat, ll.lng])} />
      </MapContainer>
    </div>
  );
}

/* ===========================
   SightingsMap (read-only)
=========================== */
export function SightingsMap({ list }: { list: BasicSighting[] }) {
  const center: [number, number] = useMemo(() => {
    if (!list?.length) return [39, -98]; // US-ish center
    const s = list[0];
    return [s.lat, s.lng];
  }, [list]);

  const ufoIcon = useMemo(
    () =>
      L.divIcon({
        html: `<div class="rounded-full p-1 bg-black/80 text-white text-xs">🛸</div>`,
        iconSize: [24, 24],
        className: "",
      }),
    []
  );

  return (
    <div className="h-[420px] rounded-2xl overflow-hidden">
      <MapContainer center={center as any} zoom={list?.length ? 7 : 4} className="h-full w-full">
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {list?.map(s => (
          <Marker key={s.id} position={[s.lat, s.lng] as any} icon={ufoIcon}>
            <Popup>
              <div className="space-y-1">
                <div className="font-medium">{s.title}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(s.when_iso).toLocaleString()}
                </div>
                <div className="text-sm">
                  {[s.shape, s.color].filter(Boolean).join(" • ")}
                </div>
                <div className="text-sm">By {s.user_name}</div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
