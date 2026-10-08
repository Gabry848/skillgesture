CREATE TABLE sg_accounts (
  id uuid PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE sg_tokens (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES sg_accounts(id),
  agent_id varchar(120) NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  admin boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sg_categories (
  account_id uuid NOT NULL REFERENCES sg_accounts(id),
  id varchar(64) NOT NULL,
  name varchar(120) NOT NULL,
  description varchar(1000) NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  preload boolean NOT NULL DEFAULT false,
  version integer NOT NULL CHECK (version > 0),
  deleted_at timestamptz,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE sg_nodes (
  account_id uuid NOT NULL,
  ref varchar(194) NOT NULL,
  category_id varchar(64) NOT NULL,
  skill_id varchar(64) NOT NULL,
  subskill_id varchar(64),
  parent_ref varchar(129),
  name varchar(120) NOT NULL,
  description varchar(1000) NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL CHECK (version > 0),
  deleted_at timestamptz,
  PRIMARY KEY (account_id, ref),
  FOREIGN KEY (account_id, category_id) REFERENCES sg_categories(account_id, id),
  FOREIGN KEY (account_id, parent_ref) REFERENCES sg_nodes(account_id, ref),
  CHECK ((subskill_id IS NULL AND parent_ref IS NULL) OR
    (subskill_id IS NOT NULL AND parent_ref = category_id || '/' || skill_id)),
  CHECK (ref = category_id || '/' || skill_id || COALESCE('/' || subskill_id, ''))
);
CREATE INDEX sg_nodes_category ON sg_nodes(account_id, category_id);

CREATE TABLE sg_versions (
  account_id uuid NOT NULL,
  ref varchar(194) NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  markdown text NOT NULL,
  PRIMARY KEY (account_id, ref, version),
  FOREIGN KEY (account_id, ref) REFERENCES sg_nodes(account_id, ref)
);

CREATE TABLE sg_blobs (
  account_id uuid NOT NULL REFERENCES sg_accounts(id),
  hash char(64) NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 5242880),
  PRIMARY KEY (account_id, hash)
);

CREATE TABLE sg_resources (
  account_id uuid NOT NULL,
  ref varchar(194) NOT NULL,
  version integer NOT NULL,
  path varchar(240) NOT NULL,
  mime_type varchar(120) NOT NULL,
  encoding varchar(6) NOT NULL CHECK (encoding IN ('utf8', 'base64')),
  size integer NOT NULL CHECK (size >= 0 AND size <= 5242880),
  blob_hash char(64) NOT NULL,
  PRIMARY KEY (account_id, ref, version, path),
  FOREIGN KEY (account_id, ref, version) REFERENCES sg_versions(account_id, ref, version),
  FOREIGN KEY (account_id, blob_hash) REFERENCES sg_blobs(account_id, hash)
);

CREATE TABLE sg_sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES sg_accounts(id),
  agent_id varchar(120) NOT NULL,
  label varchar(120) NOT NULL DEFAULT '',
  categories text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sg_sessions_owner ON sg_sessions(account_id, agent_id, id);

CREATE TABLE sg_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES sg_accounts(id),
  agent_id varchar(120) NOT NULL,
  action varchar(64) NOT NULL,
  ref varchar(194),
  version integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Original local artifacts are retained for audit/recovery. Old JSON catalogs
-- did not retain historical metadata or complete resource manifests.
CREATE TABLE sg_import_metadata (
  account_id uuid PRIMARY KEY REFERENCES sg_accounts(id),
  catalog jsonb NOT NULL,
  associations jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sg_import_files (
  account_id uuid NOT NULL,
  path text NOT NULL,
  blob_hash char(64) NOT NULL,
  PRIMARY KEY (account_id, path),
  FOREIGN KEY (account_id, blob_hash) REFERENCES sg_blobs(account_id, hash)
);
