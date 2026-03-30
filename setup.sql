ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

INSERT INTO users (name, email, password_hash, role)
VALUES (
  'IT Admin',
  'admin@yourcompany.com',
  '$2b$12$QPxM2WDeRI1QO/u/5e17OOSG7Uy/fLB3Xwq.o/iU06IaP2.2PpFQ6',
  'admin'
)
ON CONFLICT (email) DO NOTHING;
