-- Allow Postgres ON DELETE SET NULL on audit_log.institution_id when an institution
-- is deleted by admin_remove_institution, while keeping audit_log append-only.

CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT is_api_user() THEN
    IF OLD.institution_id IS NOT NULL
       AND NEW.institution_id IS NULL
       AND NEW.id = OLD.id
       AND NEW.at = OLD.at
       AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
       AND NEW.action = OLD.action
       AND NEW.object_type = OLD.object_type
       AND NEW.object_id IS NOT DISTINCT FROM OLD.object_id
       AND NEW.detail = OLD.detail THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'audit_immutable';
END;
$$;
