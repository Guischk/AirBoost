# Quick Start Guide

Get Airboost running in under 5 minutes.

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0 or higher)
- Airtable account with API access
- Your Airtable Personal Access Token

## Option 1: Deploy to Railway (Fastest)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/aircache?referralCode=3Ri9K9)

1. Click the deploy button
2. Set your environment variables:
   - `AIRTABLE_PERSONAL_TOKEN`
   - `AIRTABLE_BASE_ID`
   - `BEARER_TOKEN`
3. Deploy and you're done!

**Estimated time: 60 seconds**

## Option 2: Local Installation

### 1. Clone the Repository

```bash
git clone https://github.com/guischk/airboost.git
cd airboost
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
# Required
AIRTABLE_PERSONAL_TOKEN=pat_xxxxxxxxxxxxx
AIRTABLE_BASE_ID=appxxxxxxxxxxxxx
BEARER_TOKEN=your_secure_api_token

# Optional
PORT=3000
SYNC_MODE=polling
REFRESH_INTERVAL=86400
```

### 4. Start the Server

```bash
bun run start
```

You should see:

```
Airboost v0.2.0
Server running on http://localhost:3000
Initial cache refresh starting...
Cached 5 tables with 1,234 total records
```

### 5. Verify It's Working

```bash
# Health check (no auth required)
curl http://localhost:3000/health

# List tables (auth required)
curl -H "Authorization: Bearer your_secure_api_token" \
  http://localhost:3000/api/tables
```

## Development Mode

For development with hot reload:

```bash
bun run dev
```

Changes to source files will automatically restart the server.

## Getting Your Airtable Credentials

### Personal Access Token

1. Go to [airtable.com/create/tokens](https://airtable.com/create/tokens)
2. Click "Create new token"
3. Name it (e.g., "Airboost")
4. Add scopes:
   - `data.records:read` (required)
   - `schema.bases:read` (required for type generation)
   - `webhook:manage` (optional, for real-time sync)
5. Add your base to the access list
6. Create and copy the token

### Base ID

1. Open your Airtable base
2. Look at the URL: `airtable.com/appXXXXXXXXXXXXXX/...`
3. The Base ID starts with `app`

## Next Steps

- [Configure sync mode and other options](configuration.md)
- [Set up webhooks for real-time updates](../webhooks.md)
- [Deploy to production](../deployment/production.md)
- [Understand the architecture](../architecture/overview.md)

## Troubleshooting

### Port Already in Use

```bash
PORT=3001 bun run start
```

### Permission Denied

Ensure the data directory is writable:

```bash
mkdir -p data
chmod 755 data
```

### Invalid API Token

1. Verify your token at [airtable.com/create/tokens](https://airtable.com/create/tokens)
2. Check it has access to your specific base
3. Ensure the required scopes are enabled

### Connection Errors

Check your network can reach Airtable:

```bash
curl -I https://api.airtable.com
```
