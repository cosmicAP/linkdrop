CREATE TABLE IF NOT EXISTS links (
  id         bigserial PRIMARY KEY,
  url        text        NOT NULL,
  note       text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS links_created_at_idx ON links (created_at DESC, id DESC);
