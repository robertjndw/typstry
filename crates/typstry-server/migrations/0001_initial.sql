CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    edit_token  TEXT NOT NULL UNIQUE,
    view_token  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL
) STRICT;

-- Encrypted %ELO records exactly as clients sent them, delta spans and
-- snapshots alike. The server only reads their plaintext headers; a snapshot
-- replaces the previous one and the deltas it covers in one transaction.
CREATE TABLE doc_records (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    data        BLOB NOT NULL,
    PRIMARY KEY (project_id, seq)
) STRICT;

-- Uploads are ciphertext too, so there is no mime type to keep.
CREATE TABLE blobs (
    hash  TEXT PRIMARY KEY,
    size  INTEGER NOT NULL
) STRICT;

-- Blobs are deduplicated across projects, so access is checked through this table.
CREATE TABLE project_blobs (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    hash        TEXT NOT NULL REFERENCES blobs(hash),
    PRIMARY KEY (project_id, hash)
) STRICT;
