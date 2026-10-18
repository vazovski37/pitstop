-- No vectors (18 October 2026): reuse before writing will ask a model to choose from the
-- repository's symbol list, so the semantic index from section 10 goes. symbol_embeddings never
-- held a row. 001 still creates the extension on a fresh database, so the Postgres images
-- (docker-compose, CI) and Azure's azure.extensions allowlist keep pgvector available; nothing
-- uses it after this migration.
drop table if exists symbol_embeddings;
drop extension if exists vector;
