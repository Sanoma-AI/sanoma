-- Install once as the project administrator. Never expose this schema through the Data API.
-- Runtime logins receive only schema USAGE and gateway EXECUTE, never table privileges.
BEGIN;
CREATE SCHEMA sanoma_vault;
REVOKE ALL ON SCHEMA sanoma_vault FROM PUBLIC;
CREATE TABLE sanoma_vault.namespaces (
  login name NOT NULL,
  namespace text NOT NULL,
  prefix uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  writable boolean NOT NULL DEFAULT false,
  PRIMARY KEY (login, namespace)
);
-- Existing customer secrets are always read-only through this gateway.
CREATE TABLE sanoma_vault.external_secrets (
  login name NOT NULL,
  namespace text NOT NULL,
  path text NOT NULL,
  secret_id uuid NOT NULL,
  PRIMARY KEY (login, namespace, path),
  FOREIGN KEY (login, namespace) REFERENCES sanoma_vault.namespaces ON DELETE CASCADE
);
CREATE TABLE sanoma_vault.revisions (
  secret_id uuid PRIMARY KEY,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_by text NOT NULL,
  row_state text NOT NULL
);
REVOKE ALL ON ALL TABLES IN SCHEMA sanoma_vault FROM PUBLIC;

CREATE FUNCTION sanoma_vault.access(
  operation text, ns text, path text DEFAULT NULL, value text DEFAULT NULL,
  expected text DEFAULT NULL, actor text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE
  scope sanoma_vault.namespaces%ROWTYPE;
  external_id uuid;
  target_name text;
  item vault.secrets%ROWTYPE;
  revision uuid;
  author text;
  current_row_state text;
  version text;
  plaintext text;
BEGIN
  -- Authentication is the actual login, never a caller-controlled tenant parameter or SET ROLE.
  SELECT * INTO scope FROM sanoma_vault.namespaces
    WHERE login = session_user AND namespace = ns;
  IF NOT FOUND THEN RAISE EXCEPTION 'denied' USING ERRCODE = '42501'; END IF;
  -- A project/admin/service role can bypass this boundary; reject it as a runtime identity.
  IF pg_catalog.has_schema_privilege(session_user, 'vault', 'USAGE') THEN
    RAISE EXCEPTION 'unsafe runtime role' USING ERRCODE = '42501';
  END IF;
  IF operation = 'validate' THEN RETURN jsonb_build_object('protocol', 1, 'writable', scope.writable); END IF;
  IF operation NOT IN ('read', 'write', 'delete') OR path IS NULL OR length(path) = 0 OR length(path) > 1024 THEN
    RAISE EXCEPTION 'invalid configuration' USING ERRCODE = '22023';
  END IF;
  SELECT secret_id INTO external_id FROM sanoma_vault.external_secrets
    WHERE login = session_user AND namespace = ns AND external_secrets.path = access.path;
  IF operation <> 'read' AND (external_id IS NOT NULL OR NOT scope.writable) THEN
    RAISE EXCEPTION 'read only' USING ERRCODE = 'SV001';
  END IF;
  target_name := 'sanoma/' || scope.prefix::text || '/' || path;
  -- Supabase's project administrator can DELETE but cannot UPDATE vault.secrets,
  -- so SELECT FOR UPDATE is unavailable. Table locks use the existing DELETE
  -- grant and also coordinate ordinary Vault writers outside this gateway.
  -- Readers share a stable snapshot across the metadata and plaintext queries;
  -- writers serialize absent-row creation and compare-and-set replacement.
  IF operation = 'read' THEN
    LOCK TABLE vault.secrets IN SHARE MODE;
  ELSE
    LOCK TABLE vault.secrets IN SHARE ROW EXCLUSIVE MODE;
  END IF;
  IF external_id IS NOT NULL THEN
    SELECT * INTO item FROM vault.secrets WHERE id = external_id;
  ELSE
    SELECT * INTO item FROM vault.secrets WHERE name = target_name;
  END IF;
  IF item.id IS NOT NULL THEN
    current_row_state := encode(sha256(convert_to(item.secret || item.nonce::text || item.updated_at::text, 'UTF8')), 'hex');
    SELECT r.revision, CASE WHEN r.row_state = current_row_state THEN r.updated_by END INTO revision, author
      FROM sanoma_vault.revisions r WHERE r.secret_id = item.id;
    -- Hash encrypted bytes, never a plaintext password. Include the row identity and gateway revision.
    version := encode(sha256(convert_to(item.id::text || item.secret || item.nonce::text ||
      item.updated_at::text || coalesce(revision::text, ''), 'UTF8')), 'hex');
  END IF;
  IF operation = 'read' THEN
    IF item.id IS NULL THEN RETURN NULL; END IF;
  ELSE
    IF version IS DISTINCT FROM expected OR (operation = 'delete' AND item.id IS NULL) THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE = 'SV002';
    END IF;
    IF operation = 'delete' THEN
      DELETE FROM vault.secrets WHERE id = item.id;
      DELETE FROM sanoma_vault.revisions WHERE secret_id = item.id;
      RETURN NULL;
    END IF;
    IF value IS NULL OR actor IS NULL OR length(actor) > 1024 THEN
      RAISE EXCEPTION 'invalid value' USING ERRCODE = '22023';
    END IF;
    IF octet_length(value) > 65536 THEN RAISE EXCEPTION 'too large' USING ERRCODE = 'SV003'; END IF;
    IF item.id IS NULL THEN
      item.id := vault.create_secret(value, target_name, 'Managed by Sanoma');
    ELSE
      PERFORM vault.update_secret(item.id, value);
    END IF;
    SELECT * INTO item FROM vault.secrets WHERE id = item.id;
    current_row_state := encode(sha256(convert_to(item.secret || item.nonce::text || item.updated_at::text, 'UTF8')), 'hex');
    INSERT INTO sanoma_vault.revisions AS r (secret_id, updated_by, row_state) VALUES (item.id, actor, current_row_state)
      ON CONFLICT (secret_id) DO UPDATE SET revision = gen_random_uuid(), updated_by = excluded.updated_by, row_state = excluded.row_state
      RETURNING r.revision, r.updated_by INTO revision, author;
    SELECT * INTO item FROM vault.secrets WHERE id = item.id;
    version := encode(sha256(convert_to(item.id::text || item.secret || item.nonce::text ||
      item.updated_at::text || revision::text, 'UTF8')), 'hex');
  END IF;
  SELECT decrypted_secret INTO plaintext FROM vault.decrypted_secrets WHERE id = item.id;
  RETURN jsonb_build_object('value', plaintext, 'version', version, 'updatedAt', item.updated_at, 'updatedBy', author);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'conflict' USING ERRCODE = 'SV002';
END;
$$;
REVOKE ALL ON FUNCTION sanoma_vault.access(text, text, text, text, text, text) FROM PUBLIC;
-- Supabase may install default grants to API roles on new objects. Remove those too.
DO $revoke$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA sanoma_vault FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sanoma_vault FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sanoma_vault FROM %I', api_role);
    END IF;
  END LOOP;
END;
$revoke$;
COMMIT;
