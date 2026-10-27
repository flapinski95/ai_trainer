"use client";

import { useEffect, useRef, useState, useTransition, type TouchEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

type TouchOrigin = { x: number; y: number };

export function DashboardPullRefresh({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const touchOrigin = useRef<TouchOrigin | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isRefreshing = refreshing || isPending;
  const indicatorHeight = isRefreshing ? 42 : Math.min(42, pullDistance * 0.45);
  const indicatorVisible = isRefreshing || pullDistance > 0;

  useEffect(() => {
    if (!refreshing || isPending) return;
    const timer = window.setTimeout(() => setRefreshing(false), 500);
    return () => window.clearTimeout(timer);
  }, [isPending, refreshing]);

  function onTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 1 || event.currentTarget.scrollTop > 0 || isRefreshing) return;
    if (event.target instanceof Element && event.target.closest("a, button, input, textarea, select")) return;
    const touch = event.touches[0];
    if (!touch) return;
    touchOrigin.current = { x: touch.clientX, y: touch.clientY };
  }

  function onTouchMove(event: TouchEvent<HTMLDivElement>) {
    const origin = touchOrigin.current;
    const touch = event.touches[0];
    if (!origin || !touch || event.touches.length !== 1) return;
    const distance = touch.clientY - origin.y;
    if (distance <= 0 || Math.abs(touch.clientX - origin.x) > distance) {
      touchOrigin.current = null;
      setPullDistance(0);
      return;
    }
    setPullDistance(Math.min(distance, 96));
  }

  function onTouchEnd() {
    const shouldRefresh = pullDistance >= 72 && !isRefreshing;
    touchOrigin.current = null;
    setPullDistance(0);
    if (!shouldRefresh) return;
    setRefreshing(true);
    startTransition(() => router.refresh());
  }

  function cancelPull() {
    touchOrigin.current = null;
    setPullDistance(0);
  }

  return (
    <div
      className="screen-content journal-screen"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={cancelPull}
    >
      <div
        className="dashboard-pull-indicator"
        style={{ height: `${indicatorHeight}px`, opacity: indicatorVisible ? 1 : 0 }}
        role="status"
        aria-live="polite"
        aria-hidden={!indicatorVisible}
      >
        <LoaderCircle size={14} className={isRefreshing ? "dashboard-pull-spinner" : undefined} />
        <span>
          {isRefreshing
            ? "odświeżanie"
            : pullDistance >= 72
              ? "puść, aby odświeżyć"
              : "pociągnij, aby odświeżyć"}
        </span>
      </div>
      <div className="content journal-content">{children}</div>
    </div>
  );
}