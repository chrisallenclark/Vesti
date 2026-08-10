# apps/web — Next.js PWA

Lands in **Phase 1**.

Presentation only. Every screen is backed by a versioned JSON endpoint under
`/api/v1`; components display, never compute. That constraint is what keeps a
later Expo/TestFlight client a frontend-only project rather than a rewrite.

Connects as `vesti_app` — which cannot write orders. Trading goes through the
execution service.
