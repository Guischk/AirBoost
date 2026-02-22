# Webhook Configuration

Configure Airtable webhooks to automatically update your Airboost in real-time when data changes.

## Overview

Webhooks enable **incremental cache updates** - only modified records are refreshed instead of the entire database.

**Benefits:**
- Real-time updates (~500ms after Airtable change)
- Reduced API usage (incremental vs full refresh)
- Lower latency for end users

## Quick Setup (Auto Mode)

Airboost can automatically create and configure webhooks on startup.

### 1. Generate Webhook Secret

```bash
openssl rand -hex 32
```

### 2. Configure Environment Variables

Add to your `.env`:

```bash
# Required for auto-setup
WEBHOOK_PUBLIC_URL=https://airboost.yourcompany.com
WEBHOOK_SECRET=your_generated_secret_here

# Optional (defaults shown)
WEBHOOK_AUTO_SETUP=true
WEBHOOK_RATE_LIMIT=30
WEBHOOK_TIMESTAMP_WINDOW=300
WEBHOOK_IDEMPOTENCY_TTL=86400
```

### 3. Start Airboost

```bash
bun index.ts
```

The webhook will be automatically created. Check logs for confirmation:

```
✅ Webhook auto-setup complete (new webhook created)
   Webhook ID: achw8xKJN2m3PqRst
   Endpoint: https://airboost.yourcompany.com/webhooks/airtable/refresh
```

## Manual Setup

If you prefer manual control, disable auto-setup:

```bash
WEBHOOK_AUTO_SETUP=false
```

### Create Webhook via API

```bash
# Configuration
AIRTABLE_TOKEN="pat_your_token"
BASE_ID="app_your_base_id"
WEBHOOK_PUBLIC_URL="https://airboost.yourcompany.com"
WEBHOOK_SECRET="your_secret_here"

# Create webhook
curl -X POST "https://api.airtable.com/v0/bases/${BASE_ID}/webhooks" \
  -H "Authorization: Bearer ${AIRTABLE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"notificationUrl\": \"${WEBHOOK_PUBLIC_URL}/webhooks/airtable/refresh\",
    \"specification\": {
      \"options\": {
        \"filters\": {
          \"dataTypes\": [\"tableData\"]
        },
        \"includes\": {
          \"includeCellValuesInFieldIds\": \"all\",
          \"includePreviousCellValues\": false,
          \"includePreviousFieldDefinitions\": false
        }
      }
    }
  }"
```

### Enable Notifications

```bash
WEBHOOK_ID="achw_your_webhook_id"

curl -X POST "https://api.airtable.com/v0/bases/${BASE_ID}/webhooks/${WEBHOOK_ID}/enableNotifications" \
  -H "Authorization: Bearer ${AIRTABLE_TOKEN}"
```

## Configuration Reference

### Environment Variables

| Variable                    | Default | Description                                    |
| --------------------------- | ------- | ---------------------------------------------- |
| `WEBHOOK_PUBLIC_URL`        | -       | Public URL of your Airboost (required for auto)|
| `WEBHOOK_SECRET`            | -       | Secret for HMAC validation (min 32 chars)      |
| `WEBHOOK_AUTO_SETUP`        | `true`  | Enable automatic webhook creation              |
| `WEBHOOK_RATE_LIMIT`        | `30`    | Minimum seconds between refreshes              |
| `WEBHOOK_TIMESTAMP_WINDOW`  | `300`   | Max age of webhook timestamp (seconds)         |
| `WEBHOOK_IDEMPOTENCY_TTL`   | `86400` | Deduplication cache duration (seconds)         |

## Verification

### Test Webhook

1. Modify a record in your Airtable base
2. Check Airboost logs:

```
🔗 [Webhook] Received Airtable webhook
   Timestamp: 2026-01-22T10:30:00.000Z
   Transaction: 12345
✅ [Webhook] Signature validated
🔄 [Webhook] Triggering incremental refresh (async)
   📥 Fetching 1 records...
   ✅ 1 records updated in cache
```

### List Existing Webhooks

```bash
curl "https://api.airtable.com/v0/bases/${BASE_ID}/webhooks" \
  -H "Authorization: Bearer ${AIRTABLE_TOKEN}"
```

### Manual Test

```bash
# Generate test payload
WEBHOOK_SECRET="your_secret"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PAYLOAD="{\"timestamp\":\"$TIMESTAMP\",\"webhookId\":\"test-$(date +%s)\"}"
SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d' ' -f2)"

# Send test request
curl -X POST "https://airboost.yourcompany.com/webhooks/airtable/refresh" \
  -H "Content-Type: application/json" \
  -H "X-Airtable-Content-MAC: $SIGNATURE" \
  -d "$PAYLOAD"
```

## Troubleshooting

### Auto-Setup Errors

**Error: `WEBHOOK_PUBLIC_URL not configured`**

Set the public URL in your `.env`:
```bash
WEBHOOK_PUBLIC_URL=https://airboost.yourcompany.com
```

**Error: `Failed to create webhook: 401`**

- Verify `AIRTABLE_PERSONAL_TOKEN` is correct
- Ensure token has `data.records:write` permission
- Regenerate token at https://airtable.com/create/tokens

**Error: `Failed to create webhook: 422`**

- Ensure `WEBHOOK_PUBLIC_URL` is publicly accessible (not localhost)
- Verify URL uses HTTPS
- Test accessibility: `curl -I https://airboost.yourcompany.com/health`

### Runtime Errors

**Error: `Missing or invalid signature header`**

- Verify `WEBHOOK_SECRET` matches between Airboost and Airtable
- Check for whitespace or hidden characters in secret
- Regenerate webhook in Airtable

**Error: `Invalid signature`**

- Ensure same secret is used in both systems
- Check secret encoding (hex format from `openssl rand -hex 32`)

**Error: `Webhook timestamp expired`**

- Check network latency between Airtable and your server
- Increase `WEBHOOK_TIMESTAMP_WINDOW` if needed
- Verify server clock is synchronized (NTP)

**Error: `Rate limit exceeded`**

- Check for infinite loops (webhook triggering refresh triggering webhook)
- Increase `WEBHOOK_RATE_LIMIT` if legitimate high-frequency updates

## Security Best Practices

### Required

- Use HTTPS only (never HTTP)
- Strong secret (minimum 32 random characters)
- Never commit `.env` to version control
- Use different secrets for different environments

### Recommended

- Rotate secrets every 90 days
- Monitor rejected webhooks for abuse attempts
- Enable rate limiting
- Use environment-specific URLs (prod/staging)

### Secret Rotation

```bash
# 1. Generate new secret
NEW_SECRET=$(openssl rand -hex 32)

# 2. Update Airboost .env
WEBHOOK_SECRET=$NEW_SECRET

# 3. Restart Airboost
bun index.ts

# 4. Update Airtable webhook
curl -X PATCH "https://api.airtable.com/v0/bases/${BASE_ID}/webhooks/${WEBHOOK_ID}" \
  -H "Authorization: Bearer ${AIRTABLE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"macSecretBase64\": \"$(echo -n $NEW_SECRET | base64)\"}"
```

## Multiple Environments

Use different webhook URLs for each environment:

**Production:**
```bash
WEBHOOK_PUBLIC_URL=https://airboost.prod.com
WEBHOOK_SECRET=prod_secret_here
```

**Staging:**
```bash
WEBHOOK_PUBLIC_URL=https://airboost.staging.com
WEBHOOK_SECRET=staging_secret_here
```

Each environment will have its own Airtable webhook.

## Development with Webhooks

For local development, expose your server via a tunnel:

```bash
# Using cloudflared
cloudflared tunnel --url http://localhost:3000

# Configure the tunnel URL
WEBHOOK_PUBLIC_URL=https://xyz.trycloudflare.com
```

## Webhook Management

### Delete Webhook

```bash
WEBHOOK_ID="achw_your_webhook_id"

curl -X DELETE \
  "https://api.airtable.com/v0/bases/${BASE_ID}/webhooks/${WEBHOOK_ID}" \
  -H "Authorization: Bearer ${AIRTABLE_TOKEN}"
```

### Update Webhook URL

Airtable doesn't support updating the URL. Instead:

1. Delete the old webhook
2. Create a new webhook with the new URL
3. Or change `WEBHOOK_PUBLIC_URL` and restart Airboost (auto-setup will create new webhook)

## Webhook Lifecycle

Airtable webhooks expire after **7 days of inactivity**. Airboost handles this automatically:

- Active webhooks are refreshed on each notification
- Auto-setup recreates webhooks on restart if missing
- Monitor logs for expiration warnings

## Advanced Configuration

### Custom Webhook Filters

For advanced filtering, manually create webhooks with custom specifications:

```json
{
  "specification": {
    "options": {
      "filters": {
        "dataTypes": ["tableData"],
        "recordChangeScope": "tblXXX"  // Specific table only
      }
    }
  }
}
```

### Webhook Batching

Airtable may batch multiple changes into a single webhook notification. Airboost handles this automatically by processing all changes in the `payloads` array.

## References

- [Airtable Webhooks API](https://airtable.com/developers/web/api/webhooks-overview)
- [HMAC Authentication](https://en.wikipedia.org/wiki/HMAC)
- [Airboost Configuration](../README.md#configuration)

## Support

- [Full Documentation](../README.md)
- [Report Issues](https://github.com/guischk/airboost/issues)
- [Discussions](https://github.com/guischk/airboost/discussions)
