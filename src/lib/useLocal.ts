// src/lib/useLocal.ts
'use client';
export function useLocalSightings(_roomId?: string) {
  return { set: (_rows: any) => {}, get: () => [] as any[] };
}
