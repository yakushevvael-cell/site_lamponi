"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

const standaloneRoutes = ["/login", "/register", "/access-pending", "/password", "/privacy", "/print"];

export function SiteFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const standalone = standaloneRoutes.some((route) => pathname.startsWith(route));
  const [fullAccess, setFullAccess] = useState(false);
  const [owner, setOwner] = useState(false);
  const [permissions, setPermissions] = useState<string[]>([]);
  useEffect(() => {
    if (standalone) return;
    void fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((user: { role?: string; permissions?: string[] }) => {
        setFullAccess(user.role === "admin" || user.role === "manager");
        setOwner(user.role === "admin");
        setPermissions(Array.isArray(user.permissions) ? user.permissions : []);
      })
      .catch(() => { setFullAccess(false); setOwner(false); setPermissions([]); });
  }, [standalone]);
  if (standalone) return <>{children}</>;
  return (
    <SidebarProvider>
      <AppSidebar fullAccess={fullAccess} owner={owner} permissions={permissions} />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
