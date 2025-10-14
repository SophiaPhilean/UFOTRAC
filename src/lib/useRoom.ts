// src/lib/useRoom.ts
'use client';
import { useEffect, useState } from 'react';

function safeGet(key: string) {
  if (typeof window === 'undefined') return '';
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

export function useRoom() {
  const [roomId, setRoomId] = useState<string>(() => safeGet('ufo:room:id'));
  const [roomName, setRoomName] = useState<string>(() => safeGet('ufo:room:name'));
  const [ownerEmail, setOwnerEmail] = useState<string>(() => safeGet('ufo:room:owner'));
  const [adminCode, setAdminCode] = useState<string>(() => safeGet('ufo:room:admin'));

  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('ufo:room:id', roomId); }, [roomId]);
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('ufo:room:name', roomName); }, [roomName]);
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('ufo:room:owner', ownerEmail); }, [ownerEmail]);
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('ufo:room:admin', adminCode); }, [adminCode]);

  return { roomId, setRoomId, roomName, setRoomName, ownerEmail, setOwnerEmail, adminCode, setAdminCode };
}
