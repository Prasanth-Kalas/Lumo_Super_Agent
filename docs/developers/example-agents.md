# Example agents — a tour of the reference implementations

Four first-party agents ship with Lumo: Flight, Food, Hotel, and Restaurant. They're small, focused, and showcase the patterns you'd follow in your own agents. Source in the sibling repos under `../Lumo_*_Agent_Web/`.

## Lumo Flights (`Lumo_Flight_Agent_Web`)

- **Domain**: travel.
- **Connect model**: `lumo_id` (first-party, no external OAuth).
- **Tools**: `flight_search`, `flight_price`, `flight_book`, `flight_cancel`.
- **Interesting patterns**:
  - Returns `FlightOffersSelectCard`-shaped data so the Super Agent renders a native offers picker.
  - `flight_book` uses the two-phase confirmation pattern — first call returns `requires_confirmation: true` with the exact fare and rules; second call with a confirmation token actually books.
  - Supports the saga rollback protocol: if booked as part of a compound trip and a downstream leg fails, `flight_cancel` gets called with `x-lumo-rollback: true` and performs a refundable cancel.

Read: `../Lumo_Flight_Agent_Web/src/app/api/tools/`.

## Lumo Food (`Lumo_Food_Agent_Web`)

- **Domain**: food delivery.
- **Connect model**: `lumo_id`.
- **Tools**: `restaurant_search`, `menu_get`, `cart_add`, `cart_review`, `order_place`, `order_cancel`.
- **Interesting patterns**:
  - Multi-turn interaction — you browse restaurants, inspect a menu, add items, review, place. Each step is its own tool call; the Super Agent naturally chains them through conversation.
  - Uses `FoodMenuSelectCard` for menu rendering.
  - `order_place` is the one that actually charges — marked `x-lumo-autonomy: "spend"` and requires autonomy gate approval.

Read: `../Lumo_Food_Agent_Web/src/app/api/tools/`.

## Lumo Hotels (`Lumo_Hotel_Agent_Web`)

- **Domain**: travel.
- **Connect model**: `lumo_id`.
- **Tools**: `hotel_search`, `hotel_rate`, `hotel_book`, `hotel_cancel`.
- **Interesting patterns**:
  - Search returns a grouped result (one card per property with multiple room types inside).
  - Book uses confirmation and the saga pattern — for compound trips with both flight and hotel, if the hotel book fails after a flight is booked, the flight gets rolled back automatically.

Read: `../Lumo_Hotel_Agent_Web/src/app/api/tools/`.

## Lumo Restaurants (`Lumo_Restaurant_Agent_Web`)

- **Domain**: dining reservations.
- **Connect model**: `lumo_id`.
- **Tools**: `restaurant_search`, `restaurant_availability`, `reservation_create`, `reservation_cancel`.
- **Interesting patterns**:
  - Time-slot picker: `restaurant_availability` returns an array of open slots; the Super Agent renders `TimeSlotsSelectCard` for the user to pick one.
  - `reservation_create` is `safe_write` (reversible — reservations can be cancelled for free within the window) so auto-approves in most autonomy tiers.

Read: `../Lumo_Restaurant_Agent_Web/src/app/api/tools/`.

## The OAuth adapters (Google, Microsoft, Spotify)

These live inside the Super Agent itself (under `lib/integrations/`) but behave like first-party agents from the user's perspective. They're the best reference for how to wire OAuth correctly:

**Google** (`lib/integrations/google.ts`, `gmail.ts`, `calendar.ts`, `contacts.ts`):
- Gmail search + get message (read-only, base64url-decoded, HTML-to-plain fallback).
- Calendar list events + create event (create uses confirmation).
- Contacts search via People API.

**Microsoft** (`lib/integrations/microsoft.ts`, `microsoft-handlers.ts`):
- Outlook search messages (Graph `$search`) + get message.
- Calendar list events (`calendarView`) + create event.
- Contacts search.

**Spotify** (`lib/integrations/spotify.ts`):
- Current playback state, search, play / pause / skip / queue, recently played.
- Returns 403 on Free-tier accounts with a clear "Premium required" error — good reference for handling provider-side restrictions gracefully.

These are worth reading front-to-back if you're building an OAuth'd agent. They show:

- How to pull the token out of `agent_connections` cleanly.
- How to call the provider API idempotently.
- How to translate provider errors into `AgentError`.
- How to format responses for the Super Agent's card components.
- How to surface missing scopes and expired tokens.

## Shared patterns across all reference agents

- **Flat tool response shapes** — no nested "data" or "result" wrappers beyond what the domain needs.
- **Currency as `{ amount_cents, currency }`** — never floats.
- **Dates as strings** — `YYYY-MM-DD` for naive dates, ISO-8601 for timestamps.
- **Structured errors** — `{ error: { code, message, retryable } }` shape always.
- **Confirmation pattern for spend** — explicit two-phase call, not reliance on the autonomy engine alone.

## Where to go from these examples

- Copy the shape of whichever agent is closest to yours.
- Read its manifest first — it's the concentrated decision-making.
- Read one tool handler end-to-end.
- Read its health endpoint.
- Write your first pass against that template.

Most Lumo agents can be ~200–500 lines of code if the backend work is in an already-existing service you're wrapping. The ceremony is small; the value is in having thought through the contract.

## Related

- [quickstart.md](quickstart.md) — your own first agent.
- [authoring-guide.md](authoring-guide.md) — patterns beyond what the examples show.
- [sdk-reference.md](sdk-reference.md) — the contracts the examples implement.
