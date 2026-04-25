# Open API Agent Candidates

Last reviewed: 2026-04-25

This list is the first-party bridge plan for useful public or self-service APIs
while partner companies build native Lumo agents. These candidates are not loaded
automatically; implement each as its own agent service, then add that service to
`config/agents.registry*.json`.

## Implemented First-Party Agents

| Agent | Backing APIs | Why it matters | Auth |
| --- | --- | --- | --- |
| `open-weather` | Open-Meteo, National Weather Service | Trip planning, packing, severe-weather checks | None; NWS requires a descriptive User-Agent |
| `open-maps` | Nominatim, OSRM | Geocoding, drive/cab estimates, routing fallback | None, but public Nominatim is strictly rate-limited |
| `open-ev-charging` | Open Charge Map, Nominatim | EV road-trip and rental-car support | Server API key required for charger calls |
| `open-events` | Wikidata, optional Ticketmaster Discovery | Event discovery in destination cities | None for Wikidata; optional Ticketmaster server key |
| `open-attractions` | Nominatim, Overpass API | Destination discovery and itinerary suggestions | None, but public OSM endpoints are rate-limited |

## Build Next

| Agent | Backing APIs | Why it matters | Auth |
| --- | --- | --- | --- |
| `open-air-quality` | OpenAQ v3 | Travel-health context | Server API key |
| `open-transit` | Transitland v2 REST | Public transit fallback before cab/ride partners ship | Server API key |

## Partner Or Paid-Key Candidates

| Agent | Backing APIs | Use carefully |
| --- | --- | --- |
| `places-search` | Foursquare Places, Yelp AI / Agentic API | Discovery only unless separate commerce/reservation access is approved |
| `amadeus-travel` | Amadeus Self-Service | Already represented by Flight and Hotel agents; production booking has market/legal/consolidator gates |

## Agentization Rules

- Keep these as separate Lumo agents, not one giant utility agent, so the
  marketplace can show clear capability, terms, and health per provider.
- Use `connect.model: "none"` for read-only public data. Use server-side env
  keys for provider API keys; never expose provider keys as user connection
  tokens.
- Any tool that books, pays, reserves, or sends a user into a purchase flow must
  use `_lumo_summary`, `summary_hash`, and a cancellation/compensation story.
- Public Nominatim is for light use only. Production routing/geocoding should
  either self-host or use an approved hosted provider.
- Ticketmaster/Yelp/Foursquare should start as discovery/deep-link agents. Do
  not model them as commerce agents until partner terms explicitly allow it.

The machine-readable version lives in
`config/open-api-agent-candidates.json`.

## Source Docs

- [Open-Meteo](https://open-meteo.com/)
- [National Weather Service API](https://www.weather.gov/documentation/services-web-api)
- [OpenStreetMap Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
- [OSRM API](https://project-osrm.org/docs/v26.4.0/)
- [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)
- [Wikidata Query Service](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service)
- [Ticketmaster Discovery API](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/)
- [OpenAQ API](https://docs.openaq.org/about/about)
- [Open Charge Map API](https://www.openchargemap.org/develop/api)
- [Transitland v2 REST API](https://www.transit.land/documentation/rest-api)
- [Foursquare Places API](https://docs.foursquare.com/developer/reference/places-api-overview)
- [Yelp AI API](https://docs.developer.yelp.com/docs/yelp-ai-api)
- [Amadeus Self-Service APIs](https://developers.amadeus.com/self-service/apis-docs/guides/developer-guides/faq/)
