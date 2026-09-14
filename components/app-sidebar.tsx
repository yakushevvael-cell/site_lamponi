"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  Building2,
  ChevronRight,
  ClipboardList,
  DatabaseZap,
  LayoutGrid,
  KeyRound,
  LineChart,
  LogOut,
  PackageCheck,
  ScanLine,
  ScrollText,
  Settings2,
  UploadCloud,
  Users,
} from "lucide-react";

import type { PermissionCode } from "@/lib/permission-codes";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Пункт для полного доступа: владелец и полный доступ. */
  adminOnly?: boolean;
  /** Пункт только для владельца. */
  ownerOnly?: boolean;
  /** Пункт видно только с этим правом. Доступ всё равно проверяет сервер. */
  permission?: PermissionCode;
};

const navigation: NavItem[] = [
  { href: "/", label: "Обзор", icon: BarChart3 },
  { href: "/warehouse/my", label: "Моё задание", icon: ScanLine, permission: "warehouse.pick" },
  { href: "/warehouse", label: "Сборка и задания", icon: PackageCheck, permission: "warehouse.tasks" },
  { href: "/warehouse/problems", label: "Проблемные товары", icon: AlertTriangle, permission: "warehouse.problems" },
  { href: "/warehouse/cells", label: "Ячейки и раскладка", icon: LayoutGrid, permission: "warehouse.cells" },
  { href: "/stocks", label: "Остатки", icon: Boxes },
  { href: "/upload", label: "Загрузка ОСВ", icon: UploadCloud, permission: "warehouse.osv" },
  { href: "/orders", label: "Заказы", icon: ClipboardList, permission: "money.view" },
  { href: "/dashboards", label: "Дашборды", icon: LineChart, permission: "money.view" },
  { href: "/warehouses", label: "Склады площадок", icon: Building2 },
  { href: "/logs", label: "Журнал выгрузки", icon: ScrollText },
  { href: "/password", label: "Смена пароля", icon: KeyRound },
  { href: "/settings", label: "Подключения", icon: Settings2, ownerOnly: true },
  { href: "/users", label: "Пользователи", icon: Users, adminOnly: true },
];

export function AppSidebar({
  fullAccess,
  owner,
  permissions,
}: {
  fullAccess: boolean;
  owner: boolean;
  permissions: string[];
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.push("/login");
    router.refresh();
  }

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="gap-0 border-b border-sidebar-border/70 px-4 py-5">
        <Link href="/" className="flex items-center gap-3 overflow-hidden">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-sm">
            <DatabaseZap className="size-[18px]" />
          </span>
          <span className="min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-sm font-bold tracking-[0.16em]">LAMPONI</span>
            <span className="block truncate text-[11px] text-sidebar-foreground/55">Marketplace Hub</span>
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-2 py-4">
        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-[0.18em] text-sidebar-foreground/45">
            Управление
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation
                .filter((item) => (!item.adminOnly || fullAccess) && (!item.ownerOnly || owner))
                .filter((item) => !item.permission || permissions.includes(item.permission))
                .map((item) => {
                // «Сборка и задания» не должна подсвечиваться, когда открыто «Моё задание».
                const active = item.href === "/"
                  ? pathname === "/"
                  : item.href === "/warehouse"
                    ? pathname === "/warehouse" || pathname.startsWith("/warehouse/task")
                    : pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="h-10">
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.label}</span>
                        {active ? <ChevronRight className="ml-auto opacity-50" /> : null}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border/70 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Выйти" className="h-10" onClick={() => void logout()}>
              <LogOut />
              <span>Выйти</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
