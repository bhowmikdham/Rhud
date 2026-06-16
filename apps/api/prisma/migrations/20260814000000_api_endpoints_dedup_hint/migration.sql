-- Stop double-counting API endpoints: a web app that CONSUMES an API was
-- getting a separate vapt_api_endpoints entry duplicating the dedicated API
-- entry (e.g. CRM frontend "uses ~50 endpoints" + CRM backend API "~50
-- endpoints" → billed 100). The SYSTEM_KERNEL now carries a universal
-- de-duplication rule; this aligns the per-slug hint so it reinforces rather
-- than contradicts it. Targeted to the unedited fixture hint only (won't clobber
-- a tenant's customised hint).
UPDATE rate_card_service_lines
   SET inference_hint =
     'Emit when an API is itself a TEST TARGET and the doc names its endpoint / route / path count '
     || '(usually the dedicated API questionnaire/section). Group one API surface under one appId. '
     || 'REST/SOAP/GraphQL all count; count distinct paths when listed individually. CRITICAL — do NOT '
     || 'emit a separate entry for a web app that merely CONSUMES / uses / is built on an API that is '
     || 'already scoped on its own: that double-counts the same endpoints (e.g. a frontend "uses the '
     || 'CRM REST API ~50 endpoints" while the CRM backend API is also scoped — count the 50 ONCE). '
     || 'Only count a consumed API here when it is scoped nowhere else. "API: Yes" without a count → '
     || 'scope=1, confidence 0.5.'
 WHERE slug = 'vapt_api_endpoints'
   AND inference_hint LIKE 'Emit when the doc names a count of API endpoints%';
