// src/app/sw-register.tsx
"use client";
import { useEffect } from "react";

export default function SWRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((err) => console.error("SW register failed:", err));
    }
  }, []);
  return null;
}
