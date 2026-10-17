-- A changeset may close the intent it was declared under (CommitRequest.intentId).
-- `why` follows this link from a line to the intent behind it (design doc section 10).
alter table changesets add column intent_id text references intents (id);
