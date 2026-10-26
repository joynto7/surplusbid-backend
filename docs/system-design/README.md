# SurplusBid system design diagrams

Diagrams for the backend system design document. The schema source of truth
is [`prisma/schema.prisma`](../../prisma/schema.prisma); these were drawn from
it and from the code under `src/` on 2026-10-26.

| File | What it shows | Open with |
| --- | --- | --- |
| `surplusbid-erd.drawio` / `.png` | Database ERD: 12 tables, keys, relationships, enums and key indexes | [draw.io](https://app.diagrams.net) |
| `surplusbid.dbml` | The same schema in DBML | [dbdiagram.io](https://dbdiagram.io/d) |
| `sda-workflow-place-bid.drawio` / `.png` | SDA workflow for `POST /api/v1/lots/:id/bids`, from the client through every layer to PostgreSQL and back | draw.io |
| `backend-architecture.drawio` / `.png` | Layered architecture and where authentication, validation and error handling run | draw.io |

The `.png` files are exports of the `.drawio` sources. After editing a source,
export it again from draw.io (File → Export as → PNG, zoom 200%).
