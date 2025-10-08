import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Page Not Found",
  description: "The page you’re looking for doesn’t exist.",
};

// Next 15: put themeColor in `viewport` (not in metadata)
export const viewport: Viewport = {
  themeColor: "#0ea5e9",
};

export default function NotFound() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-2xl font-semibold mb-2">Not found</h1>
      <p className="text-sm text-muted-foreground">
        Sorry, we couldn’t find that page. Go back to the home page to continue.
      </p>
    </main>
  );
}
