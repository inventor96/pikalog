CREATE TABLE auth_sessions (
	token_hash TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

ALTER TABLE auth_login_attempts
	ADD COLUMN lock_level INTEGER NOT NULL DEFAULT 0 CHECK (lock_level >= 0);

ALTER TABLE auth_login_attempts
	ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0 CHECK (locked_until >= 0);