"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  Building2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  DatabaseZap,
  LayoutGrid,
  KeyRound,
  LineChart,
  LogOut,
  PackageCheck,
  Scale,
  ScanLine,
  ScrollText,
  Settings2,
  Truck,
  UploadCloud,
  Users,
} from "lucide-react";

import type { PermissionCode } from "@/lib/permission-codes";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
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

/**
 * Путь одной отгрузки — от задания до поставки — собран в один раздел и в том
 * порядке, в каком идёт работа: сотруднику не приходится искать свою кнопку
 * среди справочников и отчётов.
 */
const FBS_FLOW: NavItem[] = [
  { href: "/warehouse", label: "Сборка и задания", icon: PackageCheck, permission: "warehouse.tasks" },
  { href: "/warehouse/my", label: "Набрать товары", icon: ClipboardCheck, permission: "warehouse.pick" },
  { href: "/warehouse/scan", label: "Сканирование и этикетки", icon: ScanLine, permission: "warehouse.scan" },
  { href: "/warehouse/supplies", label: "Поставки", icon: Truck, permission: "warehouse.supply" },
];

const navigation: NavItem[] = [
  { href: "/", label: "Обзор", icon: BarChart3 },
  { href: "/warehouse/problems", label: "Проблемные товары", icon: AlertTriangle, permission: "warehouse.problems" },
  { href: "/warehouse/discrepancies", label: "Расхождения", icon: Scale, permission: "warehouse.problems.release" },
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

  const visible = (item: NavItem) => (!item.adminOnly || fullAccess)
    && (!item.ownerOnly || owner)
    && (!item.permission || permissions.includes(item.permission));

  // «Сборка и задания» не подсвечивается, когда открыто задание сборщика:
  // /warehouse/my и /warehouse/task — это его экран, а не список заданий.
  const isActive = (item: NavItem) => item.href === "/"
    ? pathname === "/"
    : item.href === "/warehouse"
      ? pathname === "/warehouse"
      : item.href === "/warehouse/my"
        ? pathname.startsWith("/warehouse/my") || pathname.startsWith("/warehouse/task")
        : pathname.startsWith(item.href);

  const flow = FBS_FLOW.filter(visible);
  const flowActive = flow.some((item) => isActive(item));

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
              {flow.length > 0 ? (
                <Collapsible defaultOpen={flowActive} className="group/flow">
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton
                        tooltip="Отгрузка FBS"
                        isActive={flowActive}
                        className="h-10"
                      >
                        <Truck />
                        <span>Отгрузка FBS</span>
                        <ChevronDown className="ml-auto transition-transform group-data-[state=closed]/flow:-rotate-90" />
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub className="mt-1 gap-0.5">
                        {flow.map((item) => (
                          <SidebarMenuSubItem key={item.href}>
                            <SidebarMenuSubButton asChild isActive={isActive(item)} className="h-9">
                              <Link href={item.href}>
                                <item.icon />
                                <span>{item.label}</span>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              ) : null}
              {navigation
                .filter((item) => (!item.adminOnly || fullAccess) && (!item.ownerOnly || owner))
                .filter((item) => !item.permission || permissions.includes(item.permission))
                .map((item) => {
                const active = isActive(item);
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
