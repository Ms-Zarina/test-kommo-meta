# Architecture: Kommo + Altegio + Meta CAPI Integration

## Source of Truth

**Altegio is the single source of truth for bookings and calendar.**

Kommo is the CRM (source of sales, client communication). It does NOT control the calendar.

## Data Flow

### Altegio -> Kommo (FULLY ACTIVE)

All booking changes originating in Altegio are synced to Kommo:

- **New booking** -> Create or update Kommo lead (set to BOOKING status)
- **attendance: 1** (client came) -> Move lead to status 142 (Successfully / Came)
- **attendance: -1** (no-show) -> Move lead to status 143 (Closed Lost)
- **confirmed: 1** -> Move lead to BOOKING status
- **Record fields** (datetime, services, staff, price) -> Update Kommo custom fields

Webhook: `POST /altegio/webhook`

After every successful Kommo PATCH, `markSourceTruth({source: "altegio"})` is called to suppress echo loops.

### Kommo -> Altegio (RESTRICTED: CREATE-ONLY)

- **First create**: When a lead enters BOOKING status and has NO existing `recordId`, a new Altegio record is created (with availability check, staff auto-selection, duplicate detection).
- **Updates**: DISABLED. If a lead already has a `recordId`, no PUT is sent. A note is added to the lead: "Altegio is the source of truth. Edit booking in Altegio."
- **Status writes**: DISABLED. Kommo status changes (142, 143, cancel) do NOT write attendance or delete records in Altegio.
- **Cancel**: No DELETE calls, no attendance:-1 writes from Kommo. Gated by `DISABLE_ALTEGIO_DELETE=true` (default).

Webhook: `POST /webhook/kommo`

### Meta CAPI (UNCHANGED)

Facebook Conversion API events are sent for:
- `Purchase` on attendance: 1
- `Lead` on new booking creation
- `Schedule` on booking confirmation

## Loop Prevention (3 layers)

1. **Webhook dedup** (5s TTL): Signature-based deduplication prevents processing the same webhook payload twice.
2. **Change detection**: Before PUT, GET the current record and compare fields. Skip if nothing changed.
3. **Source-of-truth echo suppression** (30s TTL): After Kommo writes to Altegio, the resulting Altegio webhook is suppressed (and vice versa). Maps: `sourceTruthByRecord`, `sourceTruthByLead`.

## Key Functions

| Function | Direction | Status |
|---|---|---|
| `syncKommoBookingToAltegio()` | Kommo -> Altegio | CREATE only; update path disabled |
| `syncKommoStatusToAltegio()` | Kommo -> Altegio | HARD DISABLED (returns immediately) |
| `cancelAltegioRecordFromKommo()` | Kommo -> Altegio | Gutted no-op |
| `handleKommoCancelKeepAltegio()` | Kommo -> Altegio | No write; gated by DISABLE_ALTEGIO_DELETE |
| `routeKommoToAltegio()` | Kommo -> Altegio | Routes: create allowed, status/update disabled |
| `/altegio/webhook` handler | Altegio -> Kommo | FULLY ACTIVE |
| `createAltegioRecordFromKommo()` | Kommo -> Altegio | Active (first-create only) |
| `updateAltegioRecordFromKommo()` | Kommo -> Altegio | EXISTS but never called (update path disabled) |

## Altegio -> Kommo Status Mapping

```
if (attendance === 1 || visit_attendance === 1)
  -> SUCCESSFULLY_STATUS_ID || 142    // client came
else if (attendance === -1 || visit_attendance === -1)
  -> CLOSED_STATUS_ID || 143          // no-show / closed lost
else if (confirmed === 1 || status === "create")
  -> BOOKING_STATUS_ID                // confirmed booking
```

Priority: attendance overrides confirmed (strict if/else-if chain).

## Service Mapping

`ALTEGIO_SERVICE_MAP` maps Kommo service names to Altegio service IDs.

Multi-service resolution:
1. Try exact full-string match first (handles service names containing commas)
2. Fall back to comma-split matching

## Staff Auto-Selection

When staff is not specified in Kommo, the system:
1. Fetches staff list for each requested service
2. Intersects to find staff who provide ALL services
3. Selects the first available staff from the intersection

## Availability Check

Before creating a record:
1. GET existing records for the target date
2. Check for time-interval overlap with the requested slot
3. If unavailable, scan 30-min grid for alternatives and add a note to Kommo

## Safety Flags

| Flag | Default | Effect |
|---|---|---|
| `DISABLE_ALTEGIO_DELETE` | `true` | Prevents attendance:-1 writes and DELETE calls from cancel path |

## Debug Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/debug/routes` | GET/POST | Service info, commit hash, webhook URLs |
| `/debug/sync-kommo-lead/:leadId` | GET/POST | Manual first-create sync (create only, no update) |
| `/debug/sync-kommo-status/:leadId` | GET/POST | READ-ONLY: shows current status, no Altegio writes |

## Webhook Reliability

- All webhook handlers always return HTTP 200 (prevents Kommo from auto-disabling webhooks)
- Route guards detect wrong-endpoint payloads (EXPECTED_ALTEGIO_BUT_GOT_KOMMO / EXPECTED_KOMMO_BUT_GOT_ALTEGIO)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | Server port (default 3000) |
| `META_PIXEL_ID` | Yes | Facebook Pixel ID |
| `META_ACCESS_TOKEN` | Yes | Meta CAPI token |
| `META_TEST_EVENT_CODE` | No | Meta test event code |
| `KOMMO_PIPELINE_ID` | Yes | Kommo pipeline ID for lead creation |
| `ALTEGIO_API_URL` | Yes | Altegio API base URL |
| `ALTEGIO_COMPANY_ID` | Yes | Altegio company ID |
| `ALTEGIO_DEFAULT_STAFF_ID` | Yes | Fallback staff ID |
| `ALTEGIO_DEFAULT_SEANCE_LENGTH` | Yes | Default session length in seconds |
| `ALTEGIO_PARTNER_TOKEN` | Yes | Altegio partner API token |
| `ALTEGIO_PARTNER_ID` | Yes | Altegio partner ID |
| `ALTEGIO_USER_TOKEN` | Yes | Altegio user API token |
| `KOMMO_ALTEGIO_RECORD_FIELD_ID` | No | Kommo custom field ID for Altegio record ID |
| `KOMMO_ALTEGIO_VISIT_FIELD_ID` | No | Kommo custom field ID for Altegio visit ID |
| `KOMMO_ALTEGIO_DATETIME_FIELD_ID` | No | Kommo custom field ID for booking datetime |
| `DISABLE_ALTEGIO_DELETE` | No | Safety flag (default: true) |

## Deployment

- Platform: Render
- Auto-deploy: Push to `main` branch triggers deploy
- Repository: `https://github.com/Ms-Zarina/test-kommo-meta.git`
