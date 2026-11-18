"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface Me {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "MEMBER";
}

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/auth/me"), staleTime: 5 * 60_000 });

export interface DashboardData {
  productCount: number;
  outOfStock: number;
  supplierCount: number;
  awaitingApproval: number;
  awaitingSend: number;
  sendFailed: number;
  awaitingDraft: number;
  unreadCritical: number;
  unreadTotal: number;
  avgRoi: number | null;
  profitableCount: number;
  simulatedCount: number;
  topRoi: { id: string; label: string; roi: number; profitJpy: string; quantity: number }[];
  queue: { id: string; threadId: string; supplier: string; status: string; text: string; updatedAt: string }[];
  recentAlerts: { id: string; type: string; severity: "INFO" | "WARNING" | "CRITICAL"; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }[];
  scrapers: { platform: string; paused: boolean }[];
}

export const useDashboard = () =>
  useQuery({ queryKey: ["dashboard"], queryFn: () => api<DashboardData>("/api/dashboard"), refetchInterval: 30_000 });
