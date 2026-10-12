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

-- The MLS group of a project. The server never reads MLS content: it
-- sequences commits and stores the sealed GroupInfo and keyring for
-- newcomers. `head_epoch` is the epoch the group is at now, so the next
-- commit must extend exactly that epoch. A reset starts a new incarnation.
CREATE TABLE mls_groups (
    project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    incarnation       INTEGER NOT NULL,
    head_epoch        INTEGER NOT NULL,
    group_id          BLOB NOT NULL,
    -- Describes `head_epoch`: every commit brings the GroupInfo of the epoch
    -- it creates.
    group_info        BLOB NOT NULL,
    keyring           BLOB NOT NULL,
    -- The public Ed25519 owner key a rotation has to be signed with before
    -- the tokens are swapped. Set by Init, replaced only by a rotation
    -- signed with the key before it, never by a reset.
    owner_key         BLOB NOT NULL CHECK (length(owner_key) = 32)
) STRICT;

-- The commit that extended `epoch`. The primary key is what makes the first
-- commit per epoch win.
CREATE TABLE mls_commits (
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    incarnation  INTEGER NOT NULL,
    epoch        INTEGER NOT NULL,
    data         BLOB NOT NULL,
    envelope     BLOB,
    -- The owner key a rotation moved the group on to, NULL for any other
    -- commit. Members learn the current owner key from it in log order.
    owner_key    BLOB CHECK (owner_key IS NULL OR length(owner_key) = 32),
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (project_id, incarnation, epoch)
) STRICT;

-- Tokens replaced by a rotation. They resolve for reading the commit log
-- only, so members who were offline can find the new links.
CREATE TABLE retired_tokens (
    token          TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    permission     TEXT NOT NULL CHECK (permission IN ('write', 'read')),
    retired_at     INTEGER NOT NULL,
    -- The epoch of the commit that carried the rotation.
    retired_epoch  INTEGER NOT NULL
) STRICT;
