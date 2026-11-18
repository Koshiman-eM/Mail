"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/misc";
import { ShareTarget } from "@/components/share/ShareTarget";

/** Android の共有メニュー (Web Share Target: GET /share?title=&text=&url=) の受け口 */
function ShareInner() {
  const sp = useSearchParams();
  return <ShareTarget title={sp.get("title") ?? ""} text={sp.get("text") ?? ""} url={sp.get("url") ?? ""} />;
}

export default function SharePage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
      <ShareInner />
    </Suspense>
  );
}
