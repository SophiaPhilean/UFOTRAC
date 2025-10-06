"use client";

import { useState, useEffect } from "react";
import InstallPWA from "./install-pwa";

export default function Home() {
  const [sightings, setSightings] = useState([]);

  useEffect(() => {
    // Load sightings from Supabase or local state
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      {/* Header with Install Button */}
      <header className="flex items-center justify-between p-4 bg-white shadow-md sticky top-0 z-10">
        <h1 className="text-xl font-bold">🛸 UFO & Drone Tracker</h1>
        <InstallPWA />
      </header>

      {/* Page Content */}
      <section className="p-6 max-w-4xl mx-auto">
        <p className="mb-4 text-lg">
          Welcome to the UFO & Drone Tracker. Report sightings and explore them
          on the map with your circle.
        </p>

        {/* Example list placeholder */}
        <div className="space-y-4">
          {sightings.length === 0 ? (
            <p className="text-gray-500">No sightings reported yet.</p>
          ) : (
            sightings.map((s, i) => (
              <div
                key={i}
                className="border rounded-lg p-4 shadow-sm bg-white hover:shadow-md transition"
              >
                <h2 className="font-semibold">{s.title}</h2>
                <p>{s.description}</p>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
