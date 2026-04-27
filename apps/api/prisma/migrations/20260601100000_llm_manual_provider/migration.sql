-- Add 'manual' as a valid LLM provider — for tenants who want to copy-
-- paste prompts into their existing ChatGPT / Claude / Gemini session
-- instead of bringing an API key.
ALTER TABLE tenant_llm_config
  DROP CONSTRAINT tenant_llm_config_provider_check;
ALTER TABLE tenant_llm_config
  ADD CONSTRAINT tenant_llm_config_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'ollama', 'openai_compat', 'manual'));
