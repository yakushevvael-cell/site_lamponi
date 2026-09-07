import type { ReactNode } from "react";

import { SidebarTrigger } from "@/components/ui/sidebar";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-4 border-b border-border/80 bg-background/90 px-4 py-3 backdrop-blur md:px-7">
      <div className="flex min-w-0 items-center gap-3">
        <SidebarTrigger className="shrink-0 md:hidden" />
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">{description}</p>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
