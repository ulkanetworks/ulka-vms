-- The video origin's access log, written by `ulka-vms origin` and the API's downloads. Segment paths are /s/<tenant>/<asset>/<rendition>/<file>.
-- Sorted by tenant then time, so one tenant's lines (a billing dispute) are read without scanning everyone's.
CREATE TABLE IF NOT EXISTS origin_access_logs (
    ts           DateTime,
    tenant_id    UUID MATERIALIZED toUUIDOrZero(splitByChar('/', uri)[3]), -- zero for paths outside /s/
    client_addr  IPv6,
    method       LowCardinality(String),
    uri          String,
    status       UInt16,
    body_bytes   UInt64, -- one response: a few MB for a segment, past 4 GB for a long MP4 download
    request_time Float32,
    user_agent   String,
    referer      String
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (tenant_id, ts)
TTL ts + INTERVAL 400 DAY -- raw lines are the dispute record, kept as long as the rollups
SETTINGS ttl_only_drop_parts = 1;

-- Video delivered from the origin, by hour and tenant. Only served responses count.
-- ponytail: cache misses pulled by the Ulka CDN are counted here too; exclude edge node addresses once nodes exist.
CREATE TABLE IF NOT EXISTS video_delivery_hourly (
    hour         DateTime,
    tenant_id    UUID,
    requests     UInt64,
    egress_bytes UInt64
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, tenant_id) -- the meter reads recent hours
TTL hour + INTERVAL 400 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS video_delivery_hourly_mv TO video_delivery_hourly AS
SELECT
    toStartOfHour(ts)                                 AS hour,
    toUUIDOrZero(splitByChar('/', uri)[3])            AS tenant_id,
    countIf(status < 400)                             AS requests,
    sumIf(toUInt64(body_bytes), status < 400)         AS egress_bytes
FROM origin_access_logs
WHERE startsWith(uri, '/s/') AND tenant_id != toUUID('00000000-0000-0000-0000-000000000000')
GROUP BY hour, tenant_id;
