"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

// Defer importing leaflet/react-leaflet until after mount (avoids "window is not defined" & CSS timing issues)
export default function SightingsMap({
  list,
  onPick,
}: {
  list: Array<{ id: string; lat: number; lng: number }>;
  onPick?: (lat: number, lng: number) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [Leaflet, setLeaflet] = useState<any>(null);
  const mapRef = useRef<any>(null);

  useEffect(() => {
    setMounted(true);
    (async () => {
      // Load CSS only on client
      await import("leaflet/dist/leaflet.css");
      const L = await import("leaflet");
      const RL = await import("react-leaflet");
      setLeaflet({ L: L.default || L, RL });
      // Fix default icon paths in some environments (optional)
      const icon = (L as any).Icon.Default;
      if (icon && icon.prototype) {
        icon.mergeOptions?.({
          iconRetinaUrl:
            "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
          iconUrl:
            "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
          shadowUrl:
            "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        });
      }
    })();
  }, []);

  // Until mounted + libraries loaded, render a placeholder that can’t crash
  if (!mounted || !Leaflet) {
    return (
      <div className="h-[420px] rounded-2xl border grid place-items-center text-sm text-muted-foreground">
        Loading map…
      </div>
    );
  }

  const { L, RL } = Leaflet;
  const { MapContainer, TileLayer, Marker, Popup, useMapEvents } = RL;

  // Build icon per sighting type (when you pass category later, you can color by it)
  const getIcon = (emoji = "🛸", bg = "bg-black/80") =>
    L.divIcon({
      html: `<div class="rounded-full p-1 ${bg} text-white text-xs">${emoji}</div>`,
      iconSize: [24, 24],
      className: "",
    });

  // Choose center
  const center = useMemo<[number, number]>(() => {
    if (!list?.length) return [39, -98]; // US-ish centroid
    return [list[0].lat, list[0].lng];
  }, [list]);

  // Inner component to wire click handler
  function Clicker() {
    useMapEvents({
      click(e: any) {
        onPick?.(e.latlng.lat, e.latlng.lng);
      },
    });
    return null;
  }

  return (
    <div className="h-[420px] rounded-2xl overflow-hidden">
      <MapContainer
        center={center as any}
        zoom={list?.length ? 7 : 4}
        className="h-full w-full"
        ref={mapRef}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {list?.map((s) => (
          <Marker
            key={s.id}
            position={[s.lat, s.lng] as any}
            icon={getIcon()}
          >
            <Popup>
              <div className="space-y-1">
                <div className="text-sm">Lat {s.lat.toFixed(3)}</div>
                <div className="text-sm">Lng {s.lng.toFixed(3)}</div>
              </div>
            </Popup>
          </Marker>
        ))}
        <Clicker />
      </MapContainer>
    </div>
  );
}
