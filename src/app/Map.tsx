"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Props:
 *   list: [{ id, lat, lng }]
 *   onPick?: (lat, lng) => void
 */
export default function SightingsMap({
  list,
  onPick,
}: {
  list: Array<{ id: string; lat: number; lng: number }>;
  onPick?: (lat: number, lng: number) => void;
}) {
  // --- Hooks must be at top; no early returns before these ---
  const [mounted, setMounted] = useState(false);
  const [Leaflet, setLeaflet] = useState<{
    L: any;
    RL: {
      MapContainer: any;
      TileLayer: any;
      Marker: any;
      Popup: any;
      useMapEvents: any;
    };
  } | null>(null);
  const mapRef = useRef<any>(null);

  // center can be memoized safely (doesn't depend on Leaflet)
  const center = useMemo<[number, number]>(() => {
    if (!list?.length) return [39, -98]; // US-ish centroid fallback
    return [list[0].lat, list[0].lng];
  }, [list]);

  useEffect(() => {
    setMounted(true);
    (async () => {
      // Load CSS and libs client-side only
      await import("leaflet/dist/leaflet.css");
      const L = await import("leaflet");
      const RL = await import("react-leaflet");

      // Fix default icon paths (optional)
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
      setLeaflet({ L: (L as any).default || L, RL: RL as any });
    })();
  }, []);

  // ❗️Only now is it safe to early-return
  if (!mounted || !Leaflet) {
    return (
      <div className="h-[420px] rounded-2xl border grid place-items-center text-sm text-muted-foreground">
        Loading map…
      </div>
    );
  }

  const { L, RL } = Leaflet;
  const { MapContainer, TileLayer, Marker, Popup, useMapEvents } = RL;

  // Helper (not a hook) – only called during render after Leaflet is loaded
  const getIcon = (emoji = "🛸", bg = "bg-black/80") =>
    L.divIcon({
      html: `<div class="rounded-full p-1 ${bg} text-white text-xs">${emoji}</div>`,
      iconSize: [24, 24],
      className: "",
    });

  // Inner component to wire clicks to parent
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
