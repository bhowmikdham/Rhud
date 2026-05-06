-- Whitelist 'gemini' as a tenant_llm_config provider value. Gemini
-- ships an OpenAI-compatible endpoint at
--   https://generativelanguage.googleapis.com/v1beta/openai
-- so the existing OpenAiCompatProvider handles it; we just need a
-- dedicated provider key so the UI can show a Google branding tile
-- and the right default base URL.

ALTER TABLE tenant_llm_config
  DROP CONSTRAINT IF EXISTS tenant_llm_config_provider_check;

ALTER TABLE tenant_llm_config
  ADD CONSTRAINT tenant_llm_config_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'gemini', 'ollama', 'openai_compat', 'manual'));
