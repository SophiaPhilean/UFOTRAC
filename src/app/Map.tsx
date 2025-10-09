"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type SightingLite = {
  id: string;
  lat: number;
  lng: number;
  title?: string;
  when_iso?: string; // ISO UTC
  user_name?: string;
  shape?: string;
  color?: string;
  car_make?: string | null;
  car_model?: string | null;
  car_color?: string | null;
};

export default function SightingsMap({
  list,
  onPick,
}: {
  list: SightingLite[];
  onPick?: (lat: number, lng: number) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [leaflet, setLeaflet] = useState<{
    L: any;
    RL: {
      MapContainer: React.ComponentType<any>;
      TileLayer: React.ComponentType<any>;
      Marker: React.ComponentType<any>;
      Popup: React.ComponentType<any>;
      useMapEvents: (arg: { click?: (e: any) => void }) => void;
    };
  } | null>(null);

  const mapRef = useRef<any>(null);

  const center = useMemo<[number, number]>(() => {
    if (!list?.length) return [39, -98];
    return [list[0].lat, list[0].lng];
  }, [list]);

  useEffect(() => {
    setMounted(true);
    (async () => {
      await import("leaflet/dist/leaflet.css");
      const Lmod = await import("leaflet");
      const RLmod = await import("react-leaflet");

      const L = (Lmod as any).default || Lmod;
      const icon = L.Icon?.Default;
      if (icon && icon.prototype && icon.mergeOptions) {
        icon.mergeOptions({
          iconRetinaUrl:
            "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
          iconUrl:
            "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
          shadowUrl:
            "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        });
      }

      setLeaflet({
        L,
        RL: RLmod as any,
      });
    })();
  }, []);

  if (!mounted || !leaflet) {
    return (
      <div className="h-[420px] rounded-2xl border grid place-items-center text-sm text-muted-foreground">
        Loading map…
      </div>
    );
  }

  const { L, RL } = leaflet;
  const { MapContainer, TileLayer, Marker, Popup, useMapEvents } = RL;

  const getIcon = (emoji = "🛸") =>
    L.divIcon({
      html: `<div class="rounded-full p-1 bg-black/80 text-white text-xs">${emoji}</div>`,
      iconSize: [24, 24],
      className: "",
    });

  function Clicker() {
    useMapEvents({
      click(e: any) {
        onPick?.(e.latlng.lat, e.latlng.lng);
      },
    });
    return null;
  }

  const iconFor = (s: SightingLite) => {
    if ((s.shape || "").toLowerCase() === "triangle") return getIcon("🔺");
    if ((s.shape || "").toLowerCase() === "cigar") return getIcon("🚬");
    if ((s.shape || "").toLowerCase() === "disc") return getIcon("💿");
    if ((s.shape || "").toLowerCase() === "lights") return getIcon("✨");
    if ((s.car_make || s.car_model)) return getIcon("🚗");
    if ((s.color || "").toLowerCase() === "red") return getIcon("🔴");
    if ((s.color || "").toLowerCase() === "blue") return getIcon("🔵");
    if ((s.color || "").toLowerCase() === "green") return getIcon("🟢");
    if ((s.color || "").toLowerCase() === "orange") return getIcon("🟠");
    return getIcon("🛸");
  };

  const formatLocal = (iso?: string) => {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const vehicleLine = (s: SightingLite) => {
    const parts = [s.car_make, s.car_model, s.car_color].filter(Boolean);
    return parts.length ? `Vehicle: ${parts.join(" • ")}` : "";
    };

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
          <Marker key={s.id} position={[s.lat, s.lng] as any} icon={iconFor(s)}>
            <Popup>
              <div className="space-y-1">
                {s.title && <div className="font-medium">{s.title}</div>}
                {s.when_iso && (
                  <div className="text-xs text-muted-foreground">
                    {formatLocal(s.when_iso)}
                  </div>
                )}
                {(s.shape || s.color) && (
                  <div className="text-sm">
                    {[s.shape, s.color].filter(Boolean).join(" • ")}
                  </div>
                )}
                {vehicleLine(s) && <div className="text-sm">{vehicleLine(s)}</div>}
                {s.user_name && <div className="text-sm">By {s.user_name}</div>}
              </div>
            </Popup>
          </Marker>
        ))}

        <Clicker />
      </MapContainer>
    </div>
  );
}
