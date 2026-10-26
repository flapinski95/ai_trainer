"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useTransition, type TouchEvent } from "react";
import { Activity, CalendarDays, MessageCircle, ShieldCheck, UserRound } from "lucide-react";

const navigation = [
  { href: "/", label: "Dziennik", icon: CalendarDays },
  { href: "/chat", label: "Odprawa", icon: MessageCircle },
  { href: "/settings", label: "Profil", icon: UserRound },
] as const;

type SwipeStart = { identifier: number; x: number; y: number; time: number };

function blocksSwipe(target: EventTarget | null, boundary: HTMLElement): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest('a, button, input, textarea, select, summary, canvas, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="tablist"], [data-swipe-ignore], dialog')) return true;
  if (document.querySelector('dialog[open], [aria-modal="true"]')) return true;
  if (window.getSelection()?.isCollapsed === false) return true;
  let element: Element | null = target;
  while (element && element !== boundary) {
    const style = getComputedStyle(element);
    if ((/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)
      || style.touchAction === "none" || style.touchAction.includes("pan-x")) return true;
    element = element.parentElement;
  }
  return false;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const mainRef = useRef<HTMLElement>(null);
  const swipeStart = useRef<SwipeStart | null>(null);
  const swipeDirection = useRef(0);
  const activeIndex = navigation.findIndex((item) => item.href === pathname);

  useEffect(() => {
    mainRef.current
      ?.querySelector<HTMLElement>(".screen-content")
      ?.scrollTo({ top: 0, behavior: "auto" });
    swipeStart.current = null;
    if (swipeDirection.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      mainRef.current?.animate([
        { opacity: 0.7, transform: `translateX(${swipeDirection.current * 12}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ], { duration: 180, easing: "ease-out" });
    }
    swipeDirection.current = 0;
  }, [pathname]);

  function beginSwipe(event: TouchEvent<HTMLElement>) {
    swipeStart.current = null;
    if (navigating || activeIndex < 0 || event.touches.length !== 1
      || !window.matchMedia("(max-width: 800px)").matches || blocksSwipe(event.target, event.currentTarget)) return;
    const touch = event.touches[0];
    if (!touch || touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return;
    swipeStart.current = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, time: performance.now() };
  }

  function moveSwipe(event: TouchEvent<HTMLElement>) {
    const start = swipeStart.current;
    const touch = Array.from(event.touches).find((item) => item.identifier === start?.identifier);
    if (!start || !touch || event.touches.length !== 1) {
      swipeStart.current = null;
      return;
    }
    const horizontal = Math.abs(touch.clientX - start.x);
    const vertical = Math.abs(touch.clientY - start.y);
    if (vertical > 12 && vertical > horizontal) swipeStart.current = null;
  }

  function finishSwipe(event: TouchEvent<HTMLElement>) {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || navigating || event.touches.length > 0 || activeIndex < 0) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.identifier);
    if (!touch || performance.now() - start.time > 800 || window.getSelection()?.isCollapsed === false) return;
    const horizontal = touch.clientX - start.x;
    const vertical = touch.clientY - start.y;
    const threshold = Math.min(96, Math.max(56, window.innerWidth * 0.15));
    if (Math.abs(horizontal) < threshold || Math.abs(horizontal) < Math.abs(vertical) * 1.7) return;
    const direction = horizontal < 0 ? 1 : -1;
    const next = navigation[activeIndex + direction];
    if (!next) return;
    swipeDirection.current = direction;
    startNavigation(() => router.push(next.href));
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="AI Trainer">
          <Activity size={25} strokeWidth={2.5} />
          <span>
            AI TRAINER<span className="brand-dot">.</span>
          </span>
        </Link>
        <div className="workspace-label">TWOJA PRZESTRZEN</div>
        <nav aria-label="Nawigacja">
          {navigation.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                className={`nav-link${active ? " active" : ""}`}
                href={href}
                aria-current={active ? "page" : undefined}
                key={href}
              >
                <Icon size={18} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <ShieldCheck size={17} />
          <span>Prywatne konto</span>
        </div>
      </aside>
      <main className="app-main" ref={mainRef} onTouchStartCapture={beginSwipe}
        onTouchMoveCapture={moveSwipe} onTouchEndCapture={finishSwipe}
        onTouchCancelCapture={() => { swipeStart.current = null; }}>{children}</main>
      {activeIndex >= 0 && <div className="position-indicator" role="status" aria-live="polite" aria-atomic="true"
        aria-label={`${navigation[activeIndex]?.label}, ekran ${activeIndex + 1} z ${navigation.length}`}>
        {navigation.map((item, index) => <span className="position-track" key={item.href} aria-hidden="true">
          <span className={`position-mark${index === activeIndex ? " active" : ""}`} />
        </span>)}
      </div>}
    </div>
  );
}