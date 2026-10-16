CREATE TABLE auth_webauthn_credentials (
	credential_id TEXT NOT NULL,
	public_key TEXT NOT NULL,
	counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
	transports TEXT NOT NULL DEFAULT '[]',
	user_id TEXT NOT NULL,
	label TEXT NOT NULL,
	device_type TEXT NOT NULL,
	backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
	rp_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (credential_id, rp_id)
);

CREATE INDEX auth_webauthn_credentials_rp_idx ON auth_webauthn_credentials(rp_id);

CREATE TABLE auth_webauthn_challenges (
	challenge TEXT PRIMARY KEY,
	purpose TEXT NOT NULL CHECK (purpose IN ('authentication', 'registration')),
	rp_id TEXT NOT NULL,
	session_hash TEXT,
	user_id TEXT,
	expires_at INTEGER NOT NULL
);

CREATE INDEX auth_webauthn_challenges_expiry_idx ON auth_webauthn_challenges(expires_at);