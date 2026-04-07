ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Site decommission status
ALTER TABLE sites ADD COLUMN IF NOT EXISTS site_status TEXT NOT NULL DEFAULT 'Active';

-- Unique index on serial number
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_serial_unique
  ON devices (serial_number)
  WHERE serial_number IS NOT NULL AND serial_number != '';

-- User site assignments
CREATE TABLE IF NOT EXISTS user_sites (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, site_id)
);

INSERT INTO users (name, email, password_hash, role)
VALUES (
  'IT Admin',
  'admin@yourcompany.com',
  '$2b$12$QPxM2WDeRI1QO/u/5e17OOSG7Uy/fLB3Xwq.o/iU06IaP2.2PpFQ6',
  'super_admin'
)
ON CONFLICT (email) DO NOTHING;
