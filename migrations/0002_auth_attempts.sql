CREATE TABLE auth_login_attempts (
	client_key TEXT PRIMARY KEY,
	window_started_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL CHECK (attempts > 0)
);