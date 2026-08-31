-- AD-186: submitted intake revisions are append-only snapshots. Corrections
-- create a new numbered revision instead of mutating or deleting prior facts.
CREATE FUNCTION "origination"."prevent_submission_revision_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'submission revisions are append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "submission_revisions_append_only"
BEFORE UPDATE OR DELETE ON "origination"."submission_revisions"
FOR EACH ROW
EXECUTE FUNCTION "origination"."prevent_submission_revision_mutation"();
