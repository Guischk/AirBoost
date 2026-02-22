<div align="center">

# Airboost

**High-performance SQLite cache for Airtable**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/aircache?referralCode=3Ri9K9)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh)

**240x faster** queries | **Zero-downtime** updates | **Real-time** webhooks

[Getting Started](#quick-start) | [Documentation](docs/README.md) | [API Reference](#api-endpoints) | [Deploy](#deployment)

</div>

---

## Why Airboost?

Airtable is great for managing data, but its API has limitations:
- **Rate limits**: 5 requests/second max
- **Latency**: 200-500ms per request
- **Quotas**: Limited by pricing plan

Airboost solves this by caching your Airtable data locally in SQLite, giving you:

| Metric | Direct Airtable | With Airboost | Improvement |
|--------|-----------------|---------------|-------------|
| Avg response | 270ms | **1-3ms** | **240x faster** |
| Rate limits | 5 req/s | **Unlimited** | No throttling |
| Availability | Dependent | **100%** | Always available |

## Features

- **Blazing Fast** - Sub-millisecond queries with SQLite
- **Real-time Sync** - Webhook support for instant updates
- **Zero Downtime** - Dual-database strategy for seamless refreshes
- **Attachment Support** - Automatic file downloading and serving
- **Type Safety** - Full TypeScript support with auto-generated types
- **Self-hosted** - Your data stays on your infrastructure
- **Simple Deployment** - One-click deploy to Railway or any platform

## Quick Start

### Option 1: Deploy to Railway (Recommended)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/aircache?referralCode=3Ri9K9)

1. Click the deploy button
2. Add your Airtable credentials
3. Done! Your cache is live in ~60 seconds

### Option 2: Local Development

```bash
# Clone the repository
git clone https://github.com/guischk/airboost.git
cd airboost

# Install dependencies
bun install

# Configure environment
cp .env.example .env
# Edit .env with your Airtable credentials

# Start the server
bun run start
```

### Option 3: Docker

```bash
docker run -d \
  -e AIRTABLE_PERSONAL_TOKEN=your_token \
  -e AIRTABLE_BASE_ID=your_base_id \
  -e BEARER_TOKEN=your_api_token \
  -p 3000:3000 \
  ghcr.io/guischk/airboost:latest
```

## Configuration

### Required Variables

```bash
AIRTABLE_PERSONAL_TOKEN=pat_your_token    # Airtable API token
AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX        # Your base ID
BEARER_TOKEN=your_secure_api_token        # API authentication
```

### Sync Modes

Airboost supports three synchronization modes:

| Mode | Description | Best For |
|------|-------------|----------|
| `polling` | Regular full refresh at interval | Most use cases (default) |
| `webhook` | Real-time updates via Airtable webhooks | Low-latency requirements |
| `manual` | Only refresh via API call | Full control |

```bash
SYNC_MODE=polling              # polling | webhook | manual
REFRESH_INTERVAL=86400         # Refresh interval in seconds (24h default)
```

### Webhook Configuration (optional)

```bash
WEBHOOK_PUBLIC_URL=https://your.domain.com  # Required for webhook mode
WEBHOOK_AUTO_SETUP=true                      # Auto-create webhook on startup
```

See [Configuration Guide](docs/getting-started/configuration.md) for all options.

## API Endpoints

All endpoints require Bearer token authentication (except `/health`).

### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (no auth required) |
| `/api/tables` | GET | List all cached tables |
| `/api/tables/:table` | GET | Get records from a table |
| `/api/tables/:table/:id` | GET | Get a specific record |
| `/api/stats` | GET | Cache statistics |
| `/api/refresh` | POST | Trigger manual cache refresh |

### Advanced Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/types` | GET | Auto-generated TypeScript types (`?format=json` for JSON) |
| `/api/mappings` | GET | List all table name mappings |
| `/api/mappings/:identifier` | GET | Get a specific mapping by ID or name |
| `/api/attachments/:table` | GET | List attachments for a table |
| `/api/attachments/:table/:record` | GET | List attachments for a record |
| `/api/attachments/:table/:record/:field` | GET | List attachments for a field |
| `/api/attachments/:table/:record/:field/:filename` | GET | Download a cached attachment |
| `/api/attachments/by-id/:id` | GET | Get attachment metadata by ID |

### Webhooks

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhooks/airtable/refresh` | POST | Receive Airtable webhook notifications (HMAC-validated) |

### Query Parameters

```bash
# Pagination
GET /api/tables/users?page=1&pageSize=50

# Filter by modification date
GET /api/tables/users?modifiedAfter=2025-01-01T00:00:00Z

# Filter records
GET /api/tables/users?filter=active

# Example with curl
curl -H "Authorization: Bearer your_token" \
  "https://your-airboost.com/api/tables/users?pageSize=10"
```

## Architecture

Airboost uses a **dual-database strategy** for zero-downtime updates:

```
                    ┌─────────────┐
   API Requests ───▶│   Active    │───▶ Response
                    │  Database   │
                    └─────────────┘
                           │
                    ┌──────┴──────┐
                    │   Atomic    │
                    │    Swap     │
                    └──────┬──────┘
                           │
                    ┌─────────────┐      ┌─────────────┐
   Airtable API ───▶│  Inactive   │◀────│   Refresh   │
                    │  Database   │      │   Worker    │
                    └─────────────┘      └─────────────┘
```

**Benefits:**
- No downtime during cache refresh
- Atomic database switching
- Consistent data at all times
- Automatic rollback on failure

## Tech Stack

- **[Bun](https://bun.sh)** - Fast JavaScript runtime
- **[SQLite](https://sqlite.org)** - Embedded database via `bun:sqlite`
- **[Elysia](https://elysiajs.com)** - Ergonomic web framework for Bun
- **[Zod](https://zod.dev)** - Runtime type validation

## Deployment

### Railway (Recommended)

One-click deployment with automatic SSL and scaling:

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/aircache?referralCode=3Ri9K9)

**Cost:** ~$2-5/month for typical usage

### Other Platforms

Airboost runs anywhere Bun runs:

- **Fly.io** - `fly launch`
- **Render** - Connect your repo
- **DigitalOcean** - App Platform or Droplet
- **VPS** - Any Linux server with Bun installed

See [Deployment Guide](docs/deployment/production.md) for detailed instructions.

## Performance

Benchmarks from a real production deployment (19 tables, 4 scenarios each):

| Scenario | SQLite | Airtable | Improvement |
|----------|--------|----------|-------------|
| Single record | 0.5ms | 288ms | **540x faster** |
| Small batch (10) | 2.2ms | 272ms | **124x faster** |
| Medium batch (50) | 2.3ms | 302ms | **129x faster** |
| Full table scan | 1.1ms | 296ms | **278x faster** |

**Average improvement: 242x faster with 99.4% latency reduction**

Run your own benchmarks:
```bash
bun run benchmark
```

## Documentation

- [Quick Start Guide](docs/getting-started/quick-start.md)
- [Configuration Reference](docs/getting-started/configuration.md)
- [Webhook Setup](docs/webhooks.md)
- [Architecture Overview](docs/architecture/overview.md)
- [Production Deployment](docs/deployment/production.md)
- [Performance Benchmarks](docs/performance/benchmarks.md)

## Development

```bash
# Install dependencies
bun install

# Start with hot reload
bun run dev

# Run tests
bun test

# Run linter
bun run check

# Full validation (lint + test + benchmark)
bun run validate
```

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting a PR.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- [GitHub Issues](https://github.com/guischk/airboost/issues) - Bug reports and feature requests
- [GitHub Discussions](https://github.com/guischk/airboost/discussions) - Questions and community

---

<div align="center">

**Built with [Bun](https://bun.sh)** | **Made by [Guischk](https://github.com/guischk)**

</div>
