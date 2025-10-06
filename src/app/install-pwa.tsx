"use client";
import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export default function InstallPWA() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [eligible, setEligible] = useState(false);

  useEffect(() => {
    // already installed? (desktop)
    const isStandalone =
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      // iOS Safari
      // @ts-ignore
      window.navigator.standalone === true;

    if (isStandalone) {
      setInstalled(true);
      return;
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault?.();
      setDeferred(e as BeforeInstallPromptEvent);
      setEligible(true);
    };

    const onInstalled = () => setInstalled(true);

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // If Chrome hasn’t fired the event yet, we still show a button with help text
    // so users know how to install (Chrome might need a couple reloads).
    setEligible(false);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  return (
    <button
      onClick={async () => {
        if (deferred) {
          await deferred.prompt();
          // optional: await deferred.userChoice;
          setDeferred(null);
        } else {
          // Fallback help: open small instructions if browser didn’t fire the event yet
          alert(
            "If no install prompt appears:\n\n" +
              "• Chrome: click the ⋮ menu → Install UFO & Drone Tracker\n" +
              "• Edge: click the ⋯ menu → Apps → Install this site as an app\n" +
              "• Safari (iPhone): Share → Add to Home Screen"
          );
        }
      }}
      className="px-3 py-1 bg-sky-600 hover:bg-sky-700 text-white rounded-lg shadow-sm text-sm"
      title={eligible ? "Install app" : "If no prompt appears, see instructions"}
    >
      📲 Install App
    </button>
  );
}
